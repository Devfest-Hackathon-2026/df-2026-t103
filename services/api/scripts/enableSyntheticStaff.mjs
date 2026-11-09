import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'project-7efcc4c4-6c86-490c-ba5';
export const DEMO_PROJECT = 'demo-synthetic-auth';
const id = /^synthetic-[a-z0-9-]{3,60}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validate(config, env, emulator = false) {
  if (config.project !== (emulator ? DEMO_PROJECT : PROJECT) || [env.FIREBASE_PROJECT_ID, env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].some(v => v && v !== config.project)) throw Error('Project mismatch');
  const hosts = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'];
  const configured = Object.keys(env).filter(k => k.endsWith('_EMULATOR_HOST') && env[k]);
  const local = v => { const m = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(v || ''); return m && Number(m[1]) <= 65535; };
  if (emulator ? hosts.some(k => !local(env[k])) || configured.some(k => !hosts.includes(k)) : configured.length) throw Error('Invalid emulator configuration');
  if (![config.facilityId, config.patientUid, config.staffUid].every(v => id.test(v || '')) || config.patientUid === config.staffUid) throw Error('Invalid synthetic identifiers');
}

export async function enableStaff({ config, passwords, auth, db, timestamp, env = process.env, emulator = false }) {
  validate(config, env, emulator);
  if (![passwords?.patient, passwords?.staff].every(p => typeof p === 'string' && p.length >= 16) || passwords.patient === passwords.staff || !/^[a-f0-9]{64}$/.test(passwords?.operationKey || '')) throw Error('Invalid secret file');
  const operationId = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const fingerprint = createHmac('sha256', Buffer.from(passwords.operationKey, 'hex')).update(JSON.stringify({ config, patient: passwords.patient, staff: passwords.staff })).digest('hex');
  const { facilityId, patientUid, staffUid } = config;
  const opRef = db.doc(`syntheticDemoOperations/${operationId}`);
  const enableRef = db.doc(`syntheticStaffEnableOperations/${operationId}`);
  const specs = [
    [`facilities/${facilityId}`, { facilityId, legalName: '架空・合成デモ専用施設（実在しません）', displayName: '架空・合成デモ専用施設（実在しません）', address: { formatted: '架空の住所（実在しません）' }, serviceAgreementVersion: 'synthetic-demo-v1', verificationStatus: 'pending', receivingEnabled: true, syntheticDemo: true, syntheticPatientUid: patientUid }],
    [`syntheticDemoPatients/${patientUid}`, { facilityId }],
    [`accounts/${patientUid}`, { uid: patientUid, accountStatus: 'onboarding_pending', onboardingState: 'legal_pending', emailVerified: false, providers: ['password'], schemaVersion: '1' }],
    [`accounts/${staffUid}`, { uid: staffUid, accountStatus: 'active', onboardingState: 'completed', emailVerified: false, providers: ['password'], schemaVersion: '1' }],
    [`facilityMemberships/${staffUid}`, { userUid: staffUid, facilityId, role: 'facility_staff', status: 'active', mfaEnforced: false, revokedAt: null }],
  ];
  let proof;
  await db.runTransaction(async tx => {
    const [opSnap, enableSnap, ...snaps] = await Promise.all([tx.get(opRef), tx.get(enableRef), ...specs.map(([path]) => tx.get(db.doc(path)))]);
    const op = opSnap.data();
    if (enableSnap.exists) throw Error('Prior activation attempt requires manual review');
    if (!op || op.completed !== true || op.version !== 1 || op.project !== config.project || op.facilityId !== facilityId || op.patientUid !== patientUid || op.staffUid !== staffUid || op.fingerprint !== fingerprint) throw Error('Fixture ledger mismatch');
    for (let i = 0; i < specs.length; i++) {
      const data = snaps[i].data();
      if (!snaps[i].exists || data?.syntheticOperationId !== operationId || !Object.entries(specs[i][1]).every(([k, v]) => same(data[k], v))) throw Error('Fixture mismatch');
    }
    for (const [kind, uid] of [['patient', patientUid], ['staff', staffUid]]) {
      const p = op[kind];
      if (!p || p.uid !== uid || p.email !== `${uid}@example.test` || typeof p.creationTime !== 'string' || !p.creationTime) throw Error('Auth proof mismatch');
    }
    proof = op.staff;
    tx.create(enableRef, { project: config.project, facilityId, patientUid, staffUid, operationId, status: 'attempting', createdAt: timestamp() });
  });
  const user = await auth.getUser(staffUid);
  if (user.uid !== proof.uid || user.email !== proof.email || user.metadata?.creationTime !== proof.creationTime || user.disabled !== true || user.emailVerified !== false) throw Error('Auth identity mismatch or already enabled');
  await auth.updateUser(staffUid, { disabled: false });
  await enableRef.update({ status: 'completed', completedAt: timestamp() });
}

export async function runCli(args, env = process.env) {
  const [project, facilityId, patientUid, staffUid, secretPath, ...extra] = args;
  if (!secretPath || extra.length) throw Error('Invalid arguments');
  const config = { project, facilityId, patientUid, staffUid };
  validate(config, env);
  const handle = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let passwords;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) throw Error('Invalid secret file');
    passwords = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  const [{ initializeApp, deleteApp }, { getAuth }, { getFirestore, FieldValue }] = await Promise.all([import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore')]);
  const app = initializeApp({ projectId: project });
  try { await enableStaff({ config, passwords, auth: getAuth(app), db: getFirestore(app), timestamp: FieldValue.serverTimestamp, env }); }
  finally { await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(() => console.log('Synthetic staff enabled.')).catch(() => { console.error('Activation failed or outcome unknown; do not retry automatically. Manual review required.'); process.exitCode = 1; });
}
