// Seeds a ready-to-use patient into the Auth + Firestore emulators so the
// Flutter patient E2E (apps/patient/test/integration/patient_intake_ui_test.dart)
// can sign in and reach the symptom UI against the real local API.
//
// Emulator-only. Requires FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST
// to be set. Mirrors the account/consent shape from test/helpers/app.ts.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { DEV_LEGAL_DOCUMENTS } from "../dist/domain/legalDocuments.js";

const EMAIL = process.env.E2E_PATIENT_EMAIL ?? "synthetic-intake-ui@example.test";
const PASSWORD = process.env.E2E_PATIENT_PASSWORD ?? "local-only-intake-123!";
const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-mmr-dev";

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Refusing to seed: emulator host env vars are not set.");
}

const app = initializeApp({ projectId: PROJECT_ID });
const auth = getAuth(app);
const db = getFirestore(app);

async function ensureUser() {
  try {
    const existing = await auth.getUserByEmail(EMAIL);
    return existing.uid;
  } catch {
    const created = await auth.createUser({
      email: EMAIL,
      password: PASSWORD,
      emailVerified: true,
    });
    return created.uid;
  }
}

async function seedLegalDocuments() {
  await db.doc("appConfigs/publicLegalVersion").set({
    ...DEV_LEGAL_DOCUMENTS,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function seedAccount(uid) {
  const ts = FieldValue.serverTimestamp();
  await db.doc(`accounts/${uid}`).set({
    uid,
    accountStatus: "active",
    onboardingState: "completed",
    emailVerified: true,
    providers: ["password"],
    schemaVersion: "1",
    createdAt: ts,
    updatedAt: ts,
  });
}

async function seedCompleteProfile(uid) {
  const ts = FieldValue.serverTimestamp();
  await db.doc(`patientProfiles/${uid}`).set({
    patientUid: uid,
    locale: "ja-JP",
    familyName: "合成",
    givenName: "太郎",
    familyNameKana: "ゴウセイ",
    givenNameKana: "タロウ",
    birthDate: "1990-01-01",
    phoneNumber: "09000000000",
    postalCode: "1000001",
    address: "東京都千代田区千代田1-1",
    profileComplete: true,
    schemaVersion: "1",
    createdAt: ts,
    updatedAt: ts,
  });
}

async function seedCurrentConsents(uid) {
  for (const type of DEV_LEGAL_DOCUMENTS.requiredConsents) {
    const doc = DEV_LEGAL_DOCUMENTS.documents[type];
    await db.collection("legalConsents").doc().set({
      subjectUid: uid,
      consentType: type,
      documentVersion: doc.version,
      documentHash: doc.documentHash,
      decision: "granted",
      method: "explicit_checkbox",
      registrationSource: "email_registration",
      occurredAt: FieldValue.serverTimestamp(),
      revokedAt: null,
      schemaVersion: "1",
    });
  }
}

// A second patient whose required consents are not current: signing in must be
// gated before intake (E2E-001B メール同意ゲート). Account exists and is active,
// but onboarding is still legal_pending with no granted consents and no profile.
const GATE_EMAIL =
  process.env.E2E_GATE_EMAIL ?? "synthetic-consent-gate@example.test";
const GATE_PASSWORD =
  process.env.E2E_GATE_PASSWORD ?? "local-only-gate-123!";

async function ensureNamedUser(email, password) {
  try {
    return (await auth.getUserByEmail(email)).uid;
  } catch {
    return (await auth.createUser({ email, password, emailVerified: true })).uid;
  }
}

async function seedLegalPendingAccount(uid) {
  const ts = FieldValue.serverTimestamp();
  await db.doc(`accounts/${uid}`).set({
    uid,
    accountStatus: "active",
    onboardingState: "legal_pending",
    emailVerified: true,
    providers: ["password"],
    schemaVersion: "1",
    createdAt: ts,
    updatedAt: ts,
  });
}

const uid = await ensureUser();
await seedLegalDocuments();
await seedAccount(uid);
await seedCompleteProfile(uid);
await seedCurrentConsents(uid);
console.log(`seeded ready patient uid=${uid} email=${EMAIL}`);

const gateUid = await ensureNamedUser(GATE_EMAIL, GATE_PASSWORD);
await seedLegalPendingAccount(gateUid);
console.log(`seeded consent-gated patient uid=${gateUid} email=${GATE_EMAIL}`);

// A separate ready patient for the deletion lifecycle E2E (E2E-005), so
// requesting/cancelling deletion never mutates the intake patient's state.
const DEL_EMAIL =
  process.env.E2E_DELETION_EMAIL ?? "synthetic-deletion@example.test";
const DEL_PASSWORD =
  process.env.E2E_DELETION_PASSWORD ?? "local-only-deletion-123!";
const delUid = await ensureNamedUser(DEL_EMAIL, DEL_PASSWORD);
await seedAccount(delUid);
await seedCompleteProfile(delUid);
await seedCurrentConsents(delUid);
console.log(`seeded deletion patient uid=${delUid} email=${DEL_EMAIL}`);

// A federated first-use patient: authenticated, but no account document exists
// yet (the OAuth Auth UID is created before any app account). /me reports
// legal_pending and intake must be gated (E2E-001C, docs/03 §3.1). No Firestore
// docs are written for this user on purpose.
const FED_EMAIL =
  process.env.E2E_FEDERATED_EMAIL ?? "synthetic-federated-new@example.test";
const FED_PASSWORD =
  process.env.E2E_FEDERATED_PASSWORD ?? "local-only-federated-123!";
const fedUid = await ensureNamedUser(FED_EMAIL, FED_PASSWORD);
console.log(`seeded federated first-use patient uid=${fedUid} email=${FED_EMAIL} (no account doc)`);
process.exit(0);
