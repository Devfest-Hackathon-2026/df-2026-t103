import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtures, EMULATOR_PROJECT, PROJECT, resolveCliTarget, runCli, validate } from "./createSyntheticDemoAccounts.mjs";

const config = { project: PROJECT, facilityId: "synthetic-facility", patientUid: "synthetic-patient", staffUid: "synthetic-staff" };
const passwords = { patient: "patient-password-12345", staff: "staff-password-123456", operationKey: "ab".repeat(32) };
function dependencies() {
  const docs = new Map();
  const users = new Map();
  const snap = (path) => ({ exists: docs.has(path), data: () => globalThis.structuredClone(docs.get(path)) });
  const db = {
    doc: (path) => ({ path, get: async () => snap(path), create: async (data) => { if (docs.has(path)) throw Object.assign(new Error("exists"), { code: 6 }); docs.set(path, globalThis.structuredClone(data)); } }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = { get: async (ref) => snap(ref.path), create: (ref, data) => writes.push(["create", ref.path, data]), update: (ref, data) => writes.push(["update", ref.path, data]) };
      await fn(tx);
      for (const [kind, path] of writes) { if (kind === "create" && docs.has(path)) throw new Error("collision"); }
      for (const [kind, path, data] of writes) docs.set(path, globalThis.structuredClone(kind === "update" ? { ...docs.get(path), ...data } : data));
    },
  };
  const auth = {
    createUser: async ({ password: _password, ...user }) => {
      if (users.has(user.uid) || [...users.values()].some((u) => u.email === user.email)) throw new Error("collision");
      const result = { ...user, metadata: { creationTime: `created-${user.uid}` } };
      users.set(user.uid, result); return globalThis.structuredClone(result);
    },
    getUser: async (uid) => { if (!users.has(uid)) throw new Error("not found"); return globalThis.structuredClone(users.get(uid)); },
  };
  return { docs, users, db, auth, timestamp: () => "timestamp" };
}
const run = (deps, options = {}) => createFixtures({ config, passwords, ...deps, ...options });
const op = (deps) => [...deps.docs.entries()].find(([p]) => p.startsWith("syntheticDemoOperations/"));

test("validates project, emulators and identifiers", () => {
  validate(config);
  assert.throws(() => validate({ ...config, project: "other" }));
  assert.throws(() => validate(config, { GCLOUD_PROJECT: "other" }));
  assert.throws(() => validate(config, { FIRESTORE_EMULATOR_HOST: "localhost" }));
  assert.throws(() => validate(config, { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" }));
  assert.throws(() => validate(config, { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" }));
  assert.throws(() => validate({ ...config, project: "demo-synthetic-auth" }));
  assert.throws(() => validate({ ...config, staffUid: config.patientUid }));
  assert.throws(() => validate({ ...config, facilityId: "real-facility" }));
  const emulatorConfig = { ...config, project: EMULATOR_PROJECT };
  const emulatorEnv = { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };
  validate(emulatorConfig, emulatorEnv, true);
  assert.throws(() => validate(emulatorConfig, { ...emulatorEnv, FIRESTORE_EMULATOR_HOST: "127.0.0.1:65536" }, true));
  assert.throws(() => validate(emulatorConfig, { ...emulatorEnv, FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" }, true));
  assert.throws(() => validate(emulatorConfig, { ...emulatorEnv, GOOGLE_CLOUD_PROJECT: PROJECT }, true));
});

test("CLI resolves and validates the explicit production target before loading SDK", async () => {
  const args = [PROJECT, config.facilityId, config.patientUid, config.staffUid, "/private/passwords.json"];
  assert.deepEqual(resolveCliTarget(args, {}), { config, secretPath: args[4] });
  for (const [badArgs, env] of [
    [["another-project", ...args.slice(1)], {}],
    [args, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }],
    [args, { GCLOUD_PROJECT: "another-project" }],
  ]) assert.throws(() => resolveCliTarget(badArgs, env));

  const directory = await mkdtemp(join(tmpdir(), "synthetic-fixture-cli-"));
  const secretPath = join(directory, "passwords.json");
  await writeFile(secretPath, JSON.stringify(passwords), { mode: 0o600 });
  const d = dependencies();
  let initializedProject;
  try {
    await runCli([...args.slice(0, 4), secretPath], {
      env: {},
      loadFirebase: async () => [
        { initializeApp: (options) => { initializedProject = options.projectId; return { delete: async () => {} }; } },
        { getAuth: () => d.auth },
        { getFirestore: () => d.db, FieldValue: { serverTimestamp: d.timestamp } },
      ],
    });
    assert.equal(initializedProject, PROJECT);
    assert.equal(d.users.size, 2);
    assert.equal(op(d)[1].completed, true);
  } finally { await rm(directory, { recursive: true }); }
});
test("creates and verifies replay without bypassing patient onboarding", async () => {
  const d = dependencies(); await run(d); await run(d);
  assert.equal(d.users.size, 2);
  assert.equal(d.docs.get(`accounts/${config.patientUid}`).onboardingState, "legal_pending");
  assert.equal(d.docs.get(`accounts/${config.patientUid}`).accountStatus, "onboarding_pending");
  assert.equal(d.docs.get(`facilityMemberships/${config.staffUid}`).facilityId, config.facilityId);
  assert.equal(d.users.get(config.staffUid).disabled, true);
  assert.equal(d.users.get(config.patientUid).disabled, false);
  assert.equal(d.docs.get(`facilities/${config.facilityId}`).syntheticPatientUid, config.patientUid);
  assert.equal(d.docs.get(`syntheticDemoPatients/${config.patientUid}`).facilityId, config.facilityId);
  assert.equal(op(d)[1].completed, true);
});
test("secret file permissions and symlinks are rejected before SDK loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-fixture-permissions-"));
  const file = join(directory, "passwords.json");
  const link = join(directory, "link.json");
  const args = [PROJECT, config.facilityId, config.patientUid, config.staffUid];
  let loads = 0;
  const options = { env: {}, loadFirebase: async () => { loads++; throw new Error("unexpected SDK load"); } };
  try {
    await writeFile(file, JSON.stringify(passwords), { mode: 0o600 });
    await symlink(file, link);
    await assert.rejects(runCli([...args, link], options));
    for (const mode of [0o400, 0o640, 0o666, 0o1600]) {
      await chmod(file, mode);
      await assert.rejects(runCli([...args, file], options));
    }
    await assert.rejects(runCli([...args, directory], options));
    assert.equal(loads, 0);
  } finally { await rm(directory, { recursive: true }); }
});
test("staff remains disabled after ledger failure and enabling it breaks replay", async () => {
  const d = dependencies(); const transaction = d.db.runTransaction; let count = 0;
  d.db.runTransaction = async (fn) => { if (++count === 2) throw new Error("ledger unavailable"); return transaction(fn); };
  await assert.rejects(run(d));
  assert.equal(d.users.get(config.staffUid).disabled, true);
  d.db.runTransaction = transaction;
  await assert.rejects(run(d));
  assert.equal(d.users.get(config.staffUid).disabled, true);
  const e = dependencies(); await run(e);
  e.users.get(config.staffUid).disabled = false;
  await assert.rejects(run(e), /Auth identity mismatch/);
});
test("rejects existing facility or patient marker before Auth writes", async () => {
  for (const path of [`facilities/${config.facilityId}`, `syntheticDemoPatients/${config.patientUid}`]) {
    const d = dependencies(); d.docs.set(path, { owner: "other" });
    await assert.rejects(run(d)); assert.deepEqual(d.docs.get(path), { owner: "other" }); assert.equal(d.users.size, 0);
  }
});
test("resumes after staff create failure, never adopts colliding user", async () => {
  const d = dependencies(); const create = d.auth.createUser;
  d.auth.createUser = async (user) => { if (user.uid === config.staffUid) throw new Error("failure"); return create(user); };
  await assert.rejects(run(d)); assert.ok(op(d)[1].patient); assert.equal(op(d)[1].staff, null);
  d.auth.createUser = create; await run(d); assert.equal(op(d)[1].completed, true);
});
test("ambiguous create response and preexisting users are never adopted or deleted", async () => {
  for (const ambiguous of [false, true]) {
    const d = dependencies(); const create = d.auth.createUser;
    if (ambiguous) d.auth.createUser = async (user) => { await create(user); throw new Error("lost response"); };
    else await create({ uid: config.patientUid, email: `${config.patientUid}@example.test`, password: "unrelated", disabled: false, emailVerified: false });
    await assert.rejects(run(d)); d.auth.createUser = create;
    await assert.rejects(run(d)); assert.equal(d.users.size, 1); assert.equal(op(d)[1].patient, null);
    assert.equal(d.docs.has(`accounts/${config.patientUid}`), false);
  }
});
test("Firestore collision and changed credentials or Auth identity fail closed", async () => {
  const d = dependencies(); const foreign = { owner: "other" }; d.docs.set(`accounts/${config.patientUid}`, foreign);
  await assert.rejects(run(d)); assert.deepEqual(d.docs.get(`accounts/${config.patientUid}`), foreign);
  assert.equal(d.users.size, 0);
  d.docs.delete(`accounts/${config.patientUid}`); await run(d);
  await assert.rejects(run(d, { passwords: { ...passwords, patient: "different-password-12345" } }));
  d.users.get(config.patientUid).metadata.creationTime = "different";
  await assert.rejects(run(d));
});
test("lost Firestore commit response is recoverable but modified docs are not", async () => {
  const d = dependencies(); const transaction = d.db.runTransaction; let count = 0;
  d.db.runTransaction = async (fn) => { await transaction(fn); if (++count === 3) throw new Error("lost commit response"); };
  await assert.rejects(run(d)); d.db.runTransaction = transaction; await run(d);
  d.docs.get(`facilityMemberships/${config.staffUid}`).facilityId = "other";
  await assert.rejects(run(d)); assert.equal(d.docs.get(`facilityMemberships/${config.staffUid}`).facilityId, "other");
});
test("lost ledger update never claims an ambiguous Auth user", async () => {
  const d = dependencies(); const transaction = d.db.runTransaction;
  d.db.runTransaction = async () => { throw new Error("ledger unavailable"); };
  await assert.rejects(run(d)); assert.equal(d.users.size, 1); assert.equal(op(d)[1].patient, null);
  d.db.runTransaction = transaction; await assert.rejects(run(d));
  assert.equal(d.users.size, 1); assert.equal(op(d)[1].patient, null);
});
test("facility collision before final transaction cannot create documents", async () => {
  const d = dependencies(); const transaction = d.db.runTransaction; let count = 0;
  d.db.runTransaction = async (fn) => { if (++count === 3) d.docs.set(`facilities/${config.facilityId}`, { owner: "other" }); return transaction(fn); };
  await assert.rejects(run(d)); assert.equal(d.users.size, 2);
  assert.equal(d.docs.has(`accounts/${config.patientUid}`), false);
});
test("existing email belonging to another UID remains untouched", async () => {
  const d = dependencies();
  d.users.set("somebody-else", { uid: "somebody-else", email: `${config.patientUid}@example.test`, metadata: { creationTime: "old" } });
  await assert.rejects(run(d)); assert.equal(d.users.size, 1);
  assert.equal(d.users.get("somebody-else").metadata.creationTime, "old");
  assert.equal(op(d)[1].patient, null);
});
