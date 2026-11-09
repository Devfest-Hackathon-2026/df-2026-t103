import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { enableStaff, DEMO_PROJECT, validate } from './enableSyntheticStaff.mjs';

const suffix = randomBytes(6).toString('hex');
const config = { project: DEMO_PROJECT, facilityId: `synthetic-facility-${suffix}`, patientUid: `synthetic-patient-${suffix}`, staffUid: `synthetic-staff-${suffix}` };
validate(config, process.env, true);
const app = initializeApp({ projectId: DEMO_PROJECT });
const auth = getAuth(app), db = getFirestore(app);
const passwords = { patient: 'test-patient-password-only', staff: 'test-staff-password-only', operationKey: 'ab'.repeat(32) };
const operationId = createHash('sha256').update(JSON.stringify(config)).digest('hex');
const fingerprint = createHmac('sha256', Buffer.from(passwords.operationKey, 'hex')).update(JSON.stringify({ config, patient: passwords.patient, staff: passwords.staff })).digest('hex');
const run = (opts = {}) => enableStaff({ config, passwords, auth, db, timestamp: FieldValue.serverTimestamp, emulator: true, ...opts });

test('isolated emulators reject mismatches and replay, and enable only the fixture staff', async () => {
  try {
    const { facilityId, patientUid, staffUid } = config;
    const patient = await auth.createUser({ uid: patientUid, email: `${patientUid}@example.test`, password: passwords.patient });
    const staff = await auth.createUser({ uid: staffUid, email: `${staffUid}@example.test`, password: passwords.staff, disabled: true });
    const proof = u => ({ uid: u.uid, email: u.email, creationTime: u.metadata.creationTime });
    const docs = [
      [`syntheticDemoOperations/${operationId}`, { ...config, fingerprint, version: 1, completed: true, patient: proof(patient), staff: proof(staff) }],
      [`facilities/${facilityId}`, { facilityId, legalName: '架空・合成デモ専用施設（実在しません）', displayName: '架空・合成デモ専用施設（実在しません）', address: { formatted: '架空の住所（実在しません）' }, serviceAgreementVersion: 'synthetic-demo-v1', verificationStatus: 'pending', receivingEnabled: true, syntheticDemo: true, syntheticPatientUid: patientUid }],
      [`syntheticDemoPatients/${patientUid}`, { facilityId }],
      [`accounts/${patientUid}`, { uid: patientUid, accountStatus: 'onboarding_pending', onboardingState: 'legal_pending', emailVerified: false, providers: ['password'], schemaVersion: '1' }],
      [`accounts/${staffUid}`, { uid: staffUid, accountStatus: 'active', onboardingState: 'completed', emailVerified: false, providers: ['password'], schemaVersion: '1' }],
      [`facilityMemberships/${staffUid}`, { userUid: staffUid, facilityId, role: 'facility_staff', status: 'active', mfaEnforced: false, revokedAt: null }],
    ];
    for (const [path, data] of docs) await db.doc(path).create(path.startsWith('syntheticDemoOperations/') ? data : { ...data, syntheticOperationId: operationId });
    await assert.rejects(run({ config: { ...config, project: 'other-project' } }));
    await assert.rejects(run({ passwords: { ...passwords, operationKey: 'cd'.repeat(32) } }));
    const membership = db.doc(`facilityMemberships/${staffUid}`);
    await membership.update({ facilityId: 'synthetic-wrong-facility' });
    await assert.rejects(run());
    await membership.update({ facilityId });
    assert.equal((await auth.getUser(staffUid)).disabled, true);
    const enableRef = db.doc(`syntheticStaffEnableOperations/${operationId}`);
    await assert.rejects(run({ auth: { getUser: async () => ({ ...staff, metadata: { creationTime: 'incorrect' } }), updateUser: () => { throw Error('unexpected update'); } } }));
    assert.equal((await enableRef.get()).data().status, 'attempting');
    assert.equal((await auth.getUser(staffUid)).disabled, true);
    // Delete only this test's disposable emulator record to exercise another independent case.
    await enableRef.delete();
    await auth.updateUser(staffUid, { disabled: false });
    await assert.rejects(run());
    assert.equal((await enableRef.get()).data().status, 'attempting');
    await enableRef.delete();
    await auth.updateUser(staffUid, { disabled: true });
    await run();
    assert.equal((await auth.getUser(staffUid)).disabled, false);
    assert.equal((await auth.getUser(patientUid)).disabled, false);
    assert.equal((await db.doc(`syntheticStaffEnableOperations/${operationId}`).get()).data().status, 'completed');
    await assert.rejects(run());
  } finally { await deleteApp(app); }
});
