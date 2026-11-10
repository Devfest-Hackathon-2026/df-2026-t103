// Only repository-owned main push CI can authorize an automatic deployment.
const required = ['ci.yaml', 'hospital-ci.yaml', 'patient-ci.yaml', 'security.yaml', 'storage-config.yaml'];

function pendingChecks(runs, sha, repository) {
  return required.filter(file => {
    const latest = runs.filter(run =>
      run.path === `.github/workflows/${file}` && run.head_sha === sha &&
      run.event === 'push' && run.head_branch === 'main' &&
      run.head_repository?.full_name === repository,
    ).sort((a, b) => b.id - a.id)[0];
    return latest?.status !== 'completed' || latest.conclusion !== 'success';
  });
}

async function gate({github, context, core}) {
  const manual = context.eventName === 'workflow_dispatch';
  const repo = {...context.repo};
  const repository = `${repo.owner}/${repo.repo}`;
  const trigger = context.payload.workflow_run;
  if (!manual && (trigger?.event !== 'push' || trigger?.head_branch !== 'main' || trigger?.head_repository?.full_name !== repository)) {
    throw new Error('Deployment requires a repository-owned main push.');
  }
  if (manual && context.ref !== 'refs/heads/main') throw new Error('Run deployment from main only.');
  const sha = manual ? context.sha : trigger.head_sha;
  const {data: main} = await github.rest.repos.getBranch({...repo, branch: 'main'});
  core.setOutput('sha', sha);
  if (sha !== main.commit.sha) {
    core.setOutput('ready', 'false');
    if (manual) throw new Error('main moved; start a new run.');
    core.info('Superseded main commit; no deployment.');
    return;
  }
  // Rollback must remain available during a CI incident; it uses an existing revision.
  if (manual && context.payload.inputs?.action === 'rollback') {
    core.setOutput('ready', 'true');
    return;
  }
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {...repo, head_sha: sha, event: 'push', per_page: 100});
  const pending = pendingChecks(runs, sha, repository);
  core.setOutput('ready', String(pending.length === 0));
  if (pending.length) {
    const message = `CI not successful for ${sha}: ${pending.join(', ')}`;
    if (manual) throw new Error(message);
    core.info(message); // The last successful CI completion will trigger a new gate.
  }
}

module.exports = gate;
module.exports.pendingChecks = pendingChecks;
