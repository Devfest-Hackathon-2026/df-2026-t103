import { pathToFileURL } from "node:url";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";

export const PROJECT = "project-7efcc4c4-6c86-490c-ba5";
export const EMULATOR_PROJECT = "demo-synthetic-auth";
const synthetic = /^synthetic-[a-z0-9-]{3,60}$/;

export function validate({ project, facilityId, patientUid, staffUid }, env = {}, emulator = false) {
  if (project !== (emulator ? EMULATOR_PROJECT : PROJECT) || [env.FIREBASE_PROJECT_ID, env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].some((v) => v && v !== project)) throw new Error("Project mismatch");
  const hosts = ["FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST"];
  const configuredHosts = Object.keys(env).filter((k) => k.endsWith("_EMULATOR_HOST") && env[k]);
  const localHost = (value) => {
    const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value ?? "");
    return match && Number(match[1]) <= 65535;
  };
  if (emulator ? hosts.some((k) => !localHost(env[k])) || configuredHosts.some((k) => !hosts.includes(k)) : configuredHosts.length > 0) throw new Error("Invalid emulator configuration");
  if (![facilityId, patientUid, staffUid].every((v) => synthetic.test(v ?? "")) || patientUid === staffUid) throw new Error("Distinct synthetic identifiers required");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function createFixtures({ config, passwords, auth, db, timestamp, emulator = false }) {
  if (emulator) {
    if (config.project !== EMULATOR_PROJECT) throw new Error("Project mismatch");
    validate({ ...config, project: PROJECT });
  } else validate(config);
  const { facilityId, patientUid, staffUid } = config;
  if (![passwords?.patient, passwords?.staff].every((p) => typeof p === "string" && p.length >= 16) || passwords.patient === passwords.staff || !/^[a-f0-9]{64}$/.test(passwords?.operationKey ?? "")) throw new Error("Two distinct passwords and a 32-byte hex operationKey required");
  const operationId = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const fingerprint = createHmac("sha256", Buffer.from(passwords.operationKey, "hex")).update(JSON.stringify({ config, patient: passwords.patient, staff: passwords.staff })).digest("hex");
  const opRef = db.doc(`syntheticDemoOperations/${operationId}`);
  const people = [{ uid: patientUid, password: passwords.patient, kind: "patient" }, { uid: staffUid, password: passwords.staff, kind: "staff" }];
  const base = { project: config.project, facilityId, patientUid, staffUid, fingerprint, version: 1 };
  const checkOp = (op) => { if (!op || !Object.entries(base).every(([k, v]) => op[k] === v)) throw new Error("Operation mismatch"); };
  try { await opRef.create({ ...base, patient: null, staff: null, completed: false }); }
  catch (error) { if (error.code !== 6 && error.code !== "already-exists") throw error; }
  const initialOp = (await opRef.get()).data();
  checkOp(initialOp);
  if (!initialOp.completed) {
    const existing = await Promise.all([`facilities/${facilityId}`, `syntheticDemoPatients/${patientUid}`, `accounts/${patientUid}`, `accounts/${staffUid}`, `facilityMemberships/${staffUid}`].map((path) => db.doc(path).get()));
    if (existing.some((snap) => snap.exists)) throw new Error("Firestore collision");
  }
  for (const person of people) {
    let op = (await opRef.get()).data();
    checkOp(op);
    const email = `${person.uid}@example.test`;
    if (!op[person.kind]) {
      // An existing UID is never adopted, even after an ambiguous create response.
      const user = await auth.createUser({ uid: person.uid, email, password: person.password, emailVerified: false, disabled: person.kind === "staff" });
      if (user.uid !== person.uid || user.email !== email || !user.metadata?.creationTime) throw new Error("Unexpected Auth creation result");
      const proof = { uid: user.uid, email: user.email, creationTime: user.metadata.creationTime };
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(opRef)).data();
        checkOp(current);
        if (current[person.kind] !== null || current.completed !== false) throw new Error("Operation changed concurrently");
        tx.update(opRef, { [person.kind]: proof });
      });
      op = (await opRef.get()).data();
      checkOp(op);
    }
    const proof = op[person.kind];
    const user = await auth.getUser(person.uid);
    if (!proof || proof.uid !== person.uid || proof.email !== email || user.uid !== proof.uid || user.email !== proof.email || user.metadata?.creationTime !== proof.creationTime || user.disabled !== (person.kind === "staff") || user.emailVerified) throw new Error("Auth identity mismatch");
  }
  await db.runTransaction(async (tx) => {
    const opSnap = await tx.get(opRef);
    const op = opSnap.data();
    checkOp(op);
    if (!op.patient || !op.staff) throw new Error("Fixture precondition changed");
    const specs = [
      [`facilities/${facilityId}`, { facilityId, legalName: "架空・合成デモ専用施設（実在しません）", displayName: "架空・合成デモ専用施設（実在しません）", address: { formatted: "架空の住所（実在しません）" }, serviceAgreementVersion: "synthetic-demo-v1", verificationStatus: "pending", receivingEnabled: true, syntheticDemo: true, syntheticPatientUid: patientUid }],
      [`syntheticDemoPatients/${patientUid}`, { facilityId }],
      [`accounts/${patientUid}`, { uid: patientUid, accountStatus: "onboarding_pending", onboardingState: "legal_pending", emailVerified: false, providers: ["password"], schemaVersion: "1" }],
      [`accounts/${staffUid}`, { uid: staffUid, accountStatus: "active", onboardingState: "completed", emailVerified: false, providers: ["password"], schemaVersion: "1" }],
      [`facilityMemberships/${staffUid}`, { userUid: staffUid, facilityId, role: "facility_staff", status: "active", mfaEnforced: false, revokedAt: null }],
    ];
    const refs = specs.map(([path]) => db.doc(path));
    const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
    if (op.completed) {
      for (let i = 0; i < specs.length; i++) {
        const data = snaps[i].data();
        if (!snaps[i].exists || data?.syntheticOperationId !== operationId || !Object.entries(specs[i][1]).every(([k, v]) => same(data[k], v))) throw new Error("Committed fixture mismatch");
      }
      return;
    }
    if (snaps.some((s) => s.exists)) throw new Error("Firestore collision");
    for (let i = 0; i < specs.length; i++) tx.create(refs[i], { ...specs[i][1], syntheticOperationId: operationId, createdAt: timestamp(), ...(i === 0 || i === 2 || i === 3 ? { updatedAt: timestamp() } : {}) });
    tx.update(opRef, { completed: true });
  });
}

export function resolveCliTarget(args, env = process.env) {
  const [project, facilityId, patientUid, staffUid, secretPath, ...extra] = args;
  if (!secretPath || extra.length) throw new Error("Usage: <project> <facility-id> <patient-uid> <staff-uid> <private-password-json-path>");
  const config = { project, facilityId, patientUid, staffUid };
  validate(config, env);
  return { config, secretPath };
}

export async function runCli(args, { env = process.env, loadFirebase = () => Promise.all([import("firebase-admin/app"), import("firebase-admin/auth"), import("firebase-admin/firestore")]) } = {}) {
  const { config, secretPath } = resolveCliTarget(args, env);
  const handle = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let passwords;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) throw new Error("Password file must be mode 0600, owned by current user, and at most 4096 bytes");
    passwords = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  const [{ initializeApp }, { getAuth }, { getFirestore, FieldValue }] = await loadFirebase();
  const app = initializeApp({ projectId: config.project });
  try {
    await createFixtures({ config, passwords, auth: getAuth(app), db: getFirestore(app), timestamp: FieldValue.serverTimestamp });
    console.log("Synthetic accounts and membership created; staff Auth is disabled, email is unverified and MFA is not enrolled.");
  } finally { await app.delete(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch(() => { console.error("Fixture creation failed. Partial resources may exist; ambiguous Auth outcomes require manual investigation. No users are deleted."); process.exitCode = 1; });
}
