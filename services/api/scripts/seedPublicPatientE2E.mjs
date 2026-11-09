// Extra fixtures for the public Flutter workflow. No production credentials.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

if (process.env.FIREBASE_PROJECT_ID !== "demo-mmr-dev" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8081") {
  throw new Error("Public E2E fixtures require the exact loopback demo emulators");
}
const app = initializeApp({ projectId: "demo-mmr-dev" });
const auth = getAuth(app);
const db = getFirestore(app);
const email = "synthetic-public-staff@example.test";
let staff;
try {
  staff = await auth.getUserByEmail(email);
} catch (error) {
  if (error.code !== "auth/user-not-found") throw error;
  staff = await auth.createUser({
    email, password: "local-only-public-staff-123!", emailVerified: true,
  });
}
const timestamp = FieldValue.serverTimestamp();
await db.doc(`accounts/${staff.uid}`).set({
  uid: staff.uid, accountStatus: "active", onboardingState: "completed",
  emailVerified: true, providers: ["password"], schemaVersion: "1",
  createdAt: timestamp, updatedAt: timestamp,
});
await db.doc("facilities/synthetic-public-facility").set({
  facilityId: "synthetic-public-facility", displayName: "合成データ受入施設",
  legalName: "合成データ受入施設", verificationStatus: "verified",
  receivingEnabled: true, serviceAgreementVersion: "v1",
  address: { formatted: "合成データの住所" }, createdAt: timestamp, updatedAt: timestamp,
});
await db.doc("facilityMemberships/synthetic-public-staff-membership").set({
  userUid: staff.uid, facilityId: "synthetic-public-facility",
  role: "facility_staff", status: "active", mfaEnforced: false,
  createdAt: timestamp, revokedAt: null,
});
// Separate fixture: never change the verified facility shared by other E2Es.
const sourcePatient = await auth.getUserByEmail("synthetic-intake-ui@example.test");
const patient = await auth.createUser({
  email: "synthetic-pending-e2e@example.test",
  password: "local-only-pending-123!", emailVerified: true,
});
const sourceAccount = await db.doc(`accounts/${sourcePatient.uid}`).get();
const sourceProfile = await db.doc(`patientProfiles/${sourcePatient.uid}`).get();
await db.doc(`accounts/${patient.uid}`).set({ ...sourceAccount.data(), uid: patient.uid });
await db.doc(`patientProfiles/${patient.uid}`).set({
  ...sourceProfile.data(), patientUid: patient.uid,
});
const consents = await db.collection("legalConsents")
  .where("subjectUid", "==", sourcePatient.uid).get();
for (const consent of consents.docs) {
  await db.collection("legalConsents").doc().set({
    ...consent.data(), subjectUid: patient.uid,
  });
}
await db.doc("facilities/synthetic-pending-e2e-facility").set({
  facilityId: "synthetic-pending-e2e-facility", displayName: "合成データ未検証受入施設",
  legalName: "合成データ未検証受入施設", verificationStatus: "pending",
  receivingEnabled: true, serviceAgreementVersion: "v1",
  syntheticDemo: true, syntheticPatientUid: patient.uid,
  address: { formatted: "合成データの住所" }, createdAt: timestamp, updatedAt: timestamp,
});
await db.doc(`syntheticDemoPatients/${patient.uid}`).set({
  facilityId: "synthetic-pending-e2e-facility",
});
await db.doc("facilityMemberships/synthetic-pending-e2e-staff-membership").set({
  userUid: staff.uid, facilityId: "synthetic-pending-e2e-facility",
  role: "facility_staff", status: "active", mfaEnforced: false,
  createdAt: timestamp, revokedAt: null,
});
console.log("Public E2E facility and staff fixtures ready (local demo only)");
await app.delete();
