import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createFixtures, EMULATOR_PROJECT as PROJECT, validate } from "./createSyntheticDemoAccounts.mjs";

validate({ project: PROJECT, facilityId: "synthetic-facility", patientUid: "synthetic-patient", staffUid: "synthetic-staff" }, process.env, true);
const app = initializeApp({ projectId: PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);
const passwords = { patient: "local-patient-password-12345", staff: "local-staff-password-123456", operationKey: "ab".repeat(32) };
const config = { project: PROJECT, facilityId: "synthetic-integration-facility", patientUid: "synthetic-integration-patient", staffUid: "synthetic-integration-staff" };
const run = (authClient = auth) => createFixtures({ config, passwords, auth: authClient, db, timestamp: FieldValue.serverTimestamp, emulator: true });

test("isolated Auth and Firestore: partial failure, retry, replay and collision", async () => {
  try {
    const failing = { createUser: (user) => user.uid === config.staffUid ? Promise.reject(new Error("injected")) : auth.createUser(user), getUser: (uid) => auth.getUser(uid) };
    await assert.rejects(run(failing));
    assert.equal((await db.doc(`facilities/${config.facilityId}`).get()).exists, false);
    assert.equal((await db.doc(`syntheticDemoPatients/${config.patientUid}`).get()).exists, false);
    await run();
    await run();
    assert.equal((await auth.getUser(config.staffUid)).disabled, true);
    assert.equal((await auth.getUser(config.patientUid)).disabled, false);
    assert.equal((await db.doc(`facilities/${config.facilityId}`).get()).data().syntheticPatientUid, config.patientUid);
    assert.equal((await db.doc(`syntheticDemoPatients/${config.patientUid}`).get()).data().facilityId, config.facilityId);
    const other = { ...config, patientUid: "synthetic-other-patient", staffUid: "synthetic-other-staff" };
    await assert.rejects(createFixtures({ config: other, passwords, auth, db, timestamp: FieldValue.serverTimestamp, emulator: true }));
    await assert.rejects(auth.getUser(other.patientUid));
    assert.equal((await db.doc(`facilities/${config.facilityId}`).get()).data().syntheticPatientUid, config.patientUid);
  } finally { await deleteApp(app); }
});
