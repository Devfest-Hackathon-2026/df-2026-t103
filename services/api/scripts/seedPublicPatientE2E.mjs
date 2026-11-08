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
console.log("Public E2E facility and staff fixtures ready (local demo only)");
await app.delete();
