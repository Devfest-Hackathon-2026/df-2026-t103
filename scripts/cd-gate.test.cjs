const {test} = require('node:test');
const assert = require('node:assert/strict');
const gate = require('./cd-gate.cjs');
const files = ['ci.yaml', 'hospital-ci.yaml', 'patient-ci.yaml', 'security.yaml', 'storage-config.yaml'];
const repository = 'owner/repo';
const runs = () => files.map((file, id) => ({id, path: `.github/workflows/${file}`, head_sha: 'sha', event: 'push', head_branch: 'main', head_repository: {full_name: repository}, status: 'completed', conclusion: 'success'}));

test('all five workflows must succeed on the exact main SHA', () => {
  assert.deepEqual(gate.pendingChecks(runs(), 'sha', repository), []);
  assert.equal(gate.pendingChecks(runs(), 'other', repository).length, 5);
  assert.deepEqual(gate.pendingChecks(runs().slice(1), 'sha', repository), ['ci.yaml']);
});
test('failed, cancelled, skipped and pending checks cannot deploy', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const input = runs();
    input[0].conclusion = conclusion;
    assert.deepEqual(gate.pendingChecks(input, 'sha', repository), ['ci.yaml']);
  }
  const input = runs();
  input[0].status = 'in_progress';
  assert.deepEqual(gate.pendingChecks(input, 'sha', repository), ['ci.yaml']);
});
test('PR, fork, branch and older success cannot authorize a deployment', () => {
  for (const update of [{event: 'pull_request'}, {head_repository: {full_name: 'fork/repo'}}, {head_branch: 'feature'}]) {
    const input = runs();
    Object.assign(input[0], update);
    assert.deepEqual(gate.pendingChecks(input, 'sha', repository), ['ci.yaml']);
  }
  const input = runs();
  input.push({...input[0], id: 999, conclusion: 'failure'});
  assert.deepEqual(gate.pendingChecks(input, 'sha', repository), ['ci.yaml']);
});

function harness({manual = false, current = 'sha', action = 'deploy', checks = runs()} = {}) {
  const outputs = {};
  return {outputs, args: {
    context: {repo: {owner: 'owner', repo: 'repo'}, eventName: manual ? 'workflow_dispatch' : 'workflow_run', ref: 'refs/heads/main', sha: 'sha', payload: {inputs: {action}, workflow_run: {event: 'push', head_branch: 'main', head_sha: 'sha', head_repository: {full_name: repository}}}},
    core: {setOutput: (key, value) => {outputs[key] = value;}, info: () => {}},
    github: {rest: {repos: {getBranch: async () => ({data: {commit: {sha: current}}})}, actions: {listWorkflowRunsForRepo: {}}}, paginate: async () => checks},
  }};
}
test('automatic gate waits, then permits the final CI completion', async () => {
  const waiting = harness({checks: runs().slice(1)});
  await gate(waiting.args);
  assert.equal(waiting.outputs.ready, 'false');
  const ready = harness();
  await gate(ready.args);
  assert.deepEqual(ready.outputs, {sha: 'sha', ready: 'true'});
});
test('superseded SHA and non-main manual dispatch do not deploy', async () => {
  const old = harness({current: 'new'});
  await gate(old.args);
  assert.equal(old.outputs.ready, 'false');
  const manual = harness({manual: true});
  manual.args.context.ref = 'refs/heads/feature';
  await assert.rejects(gate(manual.args), /main only/);
});
test('manual deploy requires CI, but explicit rollback remains available', async () => {
  const deploy = harness({manual: true, checks: []});
  await assert.rejects(gate(deploy.args), /CI not successful/);
  const rollback = harness({manual: true, action: 'rollback', checks: []});
  await gate(rollback.args);
  assert.equal(rollback.outputs.ready, 'true');
});
