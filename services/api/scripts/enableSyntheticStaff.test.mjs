import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { enableStaff, PROJECT, validate } from './enableSyntheticStaff.mjs';

const config = { project: PROJECT, facilityId: 'synthetic-facility', patientUid: 'synthetic-patient', staffUid: 'synthetic-staff' };
const passwords = { patient: 'patient-password-12345', staff: 'staff-password-123456', operationKey: 'ab'.repeat(32) };
const operationId = createHash('sha256').update(JSON.stringify(config)).digest('hex');
const fingerprint = createHmac('sha256', Buffer.from(passwords.operationKey, 'hex')).update(JSON.stringify({ config, patient: passwords.patient, staff: passwords.staff })).digest('hex');

function setup() {
  const docs = new Map();
  const op = { ...config, fingerprint, version: 1, completed: true,
    patient: { uid: config.patientUid, email: `${config.patientUid}@example.test`, creationTime: 'patient-created' },
    staff: { uid: config.staffUid, email: `${config.staffUid}@example.test`, creationTime: 'staff-created' } };
  const fixtures = [
    [`facilities/${config.facilityId}`, { facilityId: config.facilityId, legalName: '架空・合成デモ専用施設（実在しません）', displayName: '架空・合成デモ専用施設（実在しません）', address: { formatted: '架空の住所（実在しません）' }, serviceAgreementVersion: 'synthetic-demo-v1', verificationStatus: 'pending', receivingEnabled: true, syntheticDemo: true, syntheticPatientUid: config.patientUid }],
    [`syntheticDemoPatients/${config.patientUid}`, { facilityId: config.facilityId }],
    [`accounts/${config.patientUid}`, { uid: config.patientUid, accountStatus: 'onboarding_pending', onboardingState: 'legal_pending', emailVerified: false, providers: ['password'], schemaVersion: '1' }],
    [`accounts/${config.staffUid}`, { uid: config.staffUid, accountStatus: 'active', onboardingState: 'completed', emailVerified: false, providers: ['password'], schemaVersion: '1' }],
    [`facilityMemberships/${config.staffUid}`, { userUid: config.staffUid, facilityId: config.facilityId, role: 'facility_staff', status: 'active', mfaEnforced: false, revokedAt: null }],
  ];
  docs.set(`syntheticDemoOperations/${operationId}`, op);
  for (const [path, data] of fixtures) docs.set(path, { ...data, syntheticOperationId: operationId });
  const db = {
    doc: (path) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      update: async (data) => docs.set(path, { ...docs.get(path), ...data }) }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = { get: async (ref) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        create: (ref, data) => writes.push([ref.path, data]) };
      await fn(tx);
      for (const [path] of writes) if (docs.has(path)) throw Error('already exists');
      for (const [path, data] of writes) docs.set(path, data);
    },
  };
  const user = { uid: config.staffUid, email: op.staff.email, metadata: { creationTime: op.staff.creationTime }, disabled: true, emailVerified: false };
  const auth = { getUser: async () => ({ ...user }), updateUser: async (_uid, patch) => Object.assign(user, patch) };
  return { docs, db, auth, user, op };
}

test('validates target and emulator configuration', () => {
  validate(config, {});
  assert.throws(() => validate({ ...config, project: 'other' }, {}));
  assert.throws(() => validate(config, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }));
  assert.throws(() => validate(config, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }, true));
});

test('enables only the ledger-proven disabled staff after fixture checks', async () => {
  const d = setup();
  await enableStaff({ config, passwords, ...d, timestamp: () => 'now', env: {} });
  assert.equal(d.user.disabled, false);
  assert.equal(d.user.emailVerified, false);
  assert.equal(d.docs.get(`syntheticStaffEnableOperations/${operationId}`).status, 'completed');
  await assert.rejects(enableStaff({ config, passwords, ...d, timestamp: () => 'now', env: {} }));
});

test('rejects ledger, fixture, identity, and pre-existing attempt mismatches without enabling', async () => {
  for (const mutate of [
    (d) => { d.op.fingerprint = 'wrong'; },
    (d) => { d.docs.get(`facilityMemberships/${config.staffUid}`).facilityId = 'synthetic-other'; },
    (d) => { d.user.metadata.creationTime = 'wrong'; },
    (d) => { d.docs.set(`syntheticStaffEnableOperations/${operationId}`, { status: 'attempting' }); },
  ]) {
    const d = setup(); mutate(d);
    await assert.rejects(enableStaff({ config, passwords, ...d, timestamp: () => 'now', env: {} }));
    assert.equal(d.user.disabled, true);
  }
});
