import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import { initializeApp, deleteApp } from "firebase/app";
import { initializeAuth, connectAuthEmulator, signInWithEmailAndPassword, inMemoryPersistence } from "firebase/auth";
import { loadConfig } from "../../../services/api/src/config";
import { initFirebase } from "../../../services/api/src/firebase";
import { DEV_LEGAL_DOCUMENTS } from "../../../services/api/src/domain/legalDocuments";
import { createApiClient } from "../lib/api-client";
import { browserSmoke } from "./browser-smoke.mjs";
import { hospitalTenantSmoke } from "./hospital-tenant-smoke";
import { staffSessionSmoke } from "./staff-session-smoke";
import { hmacSha256Hex } from "../../../services/api/src/lib/hash";

test("hospital client and staff Cookie/BFF use real Auth + Firestore + Fastify + Next (no API stub)", { timeout: 90000 }, async () => {
  assert.equal(process.env.FIREBASE_PROJECT_ID, "demo-mmr-dev");
  for (const key of ["FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "FIREBASE_DATABASE_EMULATOR_HOST"]) assert.match(process.env[key] ?? "", /^127\.0\.0\.1:\d+$/);
  const firebase = initFirebase(loadConfig());
  const uid = `hospital-connection-${Date.now()}`;
  const email = `${uid}@example.test`;
  const password = "Synthetic-only-connection-123!";
  const membership = firebase.firestore.doc(`facilityMemberships/${uid}`);
  const browserStaffMembership = firebase.firestore.doc(`facilityMemberships/${uid}-browser-staff`);
  const browserOtherMembership = firebase.firestore.doc(`facilityMemberships/${uid}-browser-other`);
  const job = firebase.firestore.doc(`ocrJobs/${uid}`);
  const auditFixtures = Array.from({ length: 25 }, (_, i) => firebase.firestore.doc(`auditEvents/${uid}-${i}`));
  const facility = firebase.firestore.doc(`facilities/${uid}`);
  const rejectedFacility = firebase.firestore.doc(`facilities/${uid}-reject`);
  const app = initializeApp({ projectId: "demo-mmr-dev", apiKey: "demo-key" }, uid);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const patientUid = `${uid}-patient`;
  const patientApp = initializeApp({ projectId: "demo-mmr-dev", apiKey: "demo-key" }, patientUid);
  const patientAuth = initializeAuth(patientApp, { persistence: inMemoryPersistence });
  connectAuthEmulator(patientAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const patientAccount = firebase.firestore.doc(`accounts/${patientUid}`);
  const questionnaire = firebase.firestore.doc(`questionnaires/${patientUid}`);
  const revision = questionnaire.collection("revisions").doc("1");
  const consentFixtures = DEV_LEGAL_DOCUMENTS.requiredConsents.map((type) => firebase.firestore.doc(`legalConsents/${patientUid}-${type}`));
  const legalConfig = firebase.firestore.doc("appConfigs/publicLegalVersion");
  const previousLegalConfig = await legalConfig.get();
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("../../../services/api/", import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LOG_LEVEL: "info", API_CORS_ORIGINS: "http://localhost:3000,http://127.0.0.1:33090" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Real BE startup timed out")), 20000);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Real BE exited before startup")); });
      child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("Server listening")) { clearTimeout(timer); resolve(); } });
      child.stderr.on("data", () => { /* Never print runtime credentials or data. */ });
    });
    await firebase.auth.createUser({ uid, email, password, emailVerified: true });
    await signInWithEmailAndPassword(auth, email, password);
    const api = createApiClient({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, emulator: true, idToken: () => auth.currentUser!.getIdToken(), appCheckToken: async () => null });
    await assert.rejects(api.jobFailures("ocr"), { status: 403 });
    await assert.rejects(api.auditEvents(), { status: 403 });
    await assert.rejects(api.disableFacility(uid, "Synthetic emergency drill"), { status: 403 });
    await membership.set({ userUid: uid, facilityId: "synthetic-facility", role: "platform_security_admin", status: "active" });
    if (process.env.HOSPITAL_BROWSER_SMOKE === "true") {
      await browserStaffMembership.set({ userUid: uid, facilityId: uid, role: "facility_admin", status: "active" });
      await browserOtherMembership.set({ userUid: uid, facilityId: `${uid}-reject`, role: "facility_staff", status: "active" });
    }
    await job.set({ status: "failed", errorCode: "engine_unavailable", attempt: 2, updatedAt: new Date(), patientUid: "SYNTHETIC_PRIVATE_VALUE" });
    const page = await api.jobFailures("ocr");
    assert.ok(page.items.some((item) => item.failureCode === "engine_unavailable" && item.attempts === 2));
    assert.ok(!JSON.stringify(page).includes("SYNTHETIC_PRIVATE_VALUE"));
    assert.ok(!JSON.stringify(page).includes(uid), "BE must pseudonymize the legacy job ID");
    await Promise.all(auditFixtures.map((ref) => ref.set({ action: "STAFF_MEMBERSHIP_UPDATED", actorType: "staff", occurredAt: new Date("2020-01-01T00:00:00.000Z"), outcome: "success", details: { patient: "SYNTHETIC_AUDIT_PRIVATE_VALUE" }, facilityId: uid, actorUidHash: uid, requestId: uid })));
    const audits = await api.auditEvents();
    assert.ok(audits.nextCursor, "Real backend must paginate the audit records");
    const olderAudits = await api.auditEvents(audits.nextCursor!);
    const summaries = [...audits.items, ...olderAudits.items];
    assert.equal(summaries.filter((item) => item.action === "STAFF_MEMBERSHIP_UPDATED").length, 25);
    assert.equal(new Set(summaries.map((item) => item.eventId)).size, summaries.length);
    assert.ok(!JSON.stringify({ audits, olderAudits }).includes("SYNTHETIC_AUDIT_PRIVATE_VALUE"));
    assert.ok(!JSON.stringify({ audits, olderAudits }).includes(uid));
    for (const ref of [facility, rejectedFacility]) await ref.set({ legalName: "合成審査施設", displayName: "合成審査施設", receivingEnabled: true, verificationStatus: "pending", createdAt: new Date(), contactChannel: { private: "SYNTHETIC_REVIEW_PRIVATE_VALUE" } });
    const reviewPage = await api.reviewFacilities();
    assert.ok(reviewPage.items.some((item) => item.facilityId === uid));
    assert.ok(!JSON.stringify(reviewPage).includes("SYNTHETIC_REVIEW_PRIVATE_VALUE"));
    await assert.rejects(api.reviewFacility(uid, "verified", { checks: { existence: true, applicant: false, receiverContact: true, location: true }, verificationRecordId: "SYNTHETIC_REFERENCE" }));
    const allChecks = { existence: true, applicant: true, receiverContact: true, location: true };
    // E2E-006: use a separate real patient token, valid consent and a finalized
    // synthetic questionnaire. A successful delivery before stopping proves that
    // later 412 responses are not just unrelated auth/consent/fixture failures.
    const patientEmail = `${patientUid}@example.test`;
    await firebase.auth.createUser({ uid: patientUid, email: patientEmail, password, emailVerified: true });
    await signInWithEmailAndPassword(patientAuth, patientEmail, password);
    await legalConfig.set({ ...DEV_LEGAL_DOCUMENTS, updatedAt: new Date() });
    await patientAccount.set({ uid: patientUid, accountStatus: "active", onboardingState: "completed", emailVerified: true, providers: ["password"], schemaVersion: "1", createdAt: new Date(), updatedAt: new Date() });
    await Promise.all(consentFixtures.map((ref, i) => {
      const type = DEV_LEGAL_DOCUMENTS.requiredConsents[i]!;
      const document = DEV_LEGAL_DOCUMENTS.documents[type]!;
      return ref.set({ subjectUid: patientUid, consentType: type, documentVersion: document.version, documentHash: document.documentHash, decision: "granted", revokedAt: null, occurredAt: new Date() });
    }));
    await questionnaire.set({ patientUid, status: "finalized" });
    await revision.set({ versionNumber: 1, patientUid, schemaVersion: "1", chiefComplaint: { value: "SYNTHETIC_QUESTIONNAIRE", source: "patient" }, sections: {}, bodyLocations: [], unansweredTopics: [], medicalHistorySnapshot: [], medicationSnapshots: [], rawAnswerSnapshotHash: "a".repeat(64), summaryReviewConfirmedAt: new Date(), createdAt: new Date() });
    const deliveryBody = { questionnaireId: patientUid, questionnaireRevision: 1, facilityId: uid, consentDocumentVersion: DEV_LEGAL_DOCUMENTS.documents.hospital_disclosure!.version, shareScope: { includeProfile: true, includeConfirmedMedications: false, includePrescriptionImages: false } };
    const sendDelivery = async (key: string) => fetch(`http://127.0.0.1:${port}/v1/deliveries`, { method: "POST", headers: { Authorization: `Bearer ${await patientAuth.currentUser!.getIdToken()}`, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(deliveryBody) });
    let deliveredId: string | undefined;
    let deliveredBeforeStop: unknown;
    let browserDeliveryId: string | undefined;
    let browserDeliveryBefore: Record<string, unknown> | undefined;
    const expectedDeliveryCount = process.env.HOSPITAL_BROWSER_SMOKE === "true" ? 2 : 1;
    const assertReceivingAndDeliver = async () => {
      assert.equal((await facility.get()).data()?.receivingEnabled, true);
      const response = await sendDelivery(`${patientUid}-before-stop`);
      assert.equal(response.status, 202, "Valid patient must be able to send before the facility stop");
      const result = await response.json() as { deliveryId: string };
      assert.equal(typeof result.deliveryId, "string");
      deliveredId = result.deliveryId;
      deliveredBeforeStop = (await firebase.firestore.doc(`deliveries/${deliveredId}`).get()).data();
      assert.equal((deliveredBeforeStop as { status: string }).status, "delivered");
      if (process.env.HOSPITAL_BROWSER_SMOKE === "true") {
        const browserDelivery = await sendDelivery(`${patientUid}-browser-ack`);
        assert.equal(browserDelivery.status, 202);
        browserDeliveryId = (await browserDelivery.json() as { deliveryId: string }).deliveryId;
        assert.equal(typeof browserDeliveryId, "string");
        assert.notEqual(browserDeliveryId, deliveredId, "Browser ack must not mutate the stop/tenant scenario delivery");
        browserDeliveryBefore = (await firebase.firestore.doc(`deliveries/${browserDeliveryId}`).get()).data();
      }
      return { browserDeliveryId };
    };
    const assertBrowserDelivery = async (status: "delivered" | "acknowledged") => {
      const actual = (await firebase.firestore.doc(`deliveries/${browserDeliveryId}`).get()).data();
      assert.equal(actual?.status, status);
      if (status === "delivered") assert.deepEqual(actual, browserDeliveryBefore, "Viewing/canceling must not acknowledge");
      else {
        assert.ok(actual?.acknowledgedAt, "UI confirmation must persist the acknowledgment timestamp");
        assert.deepEqual(actual?.questionnaireSnapshot, browserDeliveryBefore?.questionnaireSnapshot);
        assert.equal(actual?.snapshotSha256, browserDeliveryBefore?.snapshotSha256);
        const audits = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hmacSha256Hex(loadConfig().hmacSecret, `audit-res:${browserDeliveryId}`)).get();
        assert.equal(audits.docs.filter((doc) => doc.data().action === "DELIVERY_ACKNOWLEDGED" && doc.data().decision === "allow").length, 1);
      }
    };
    if (process.env.HOSPITAL_BROWSER_SMOKE === "true") await browserSmoke({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, authHost: process.env.FIREBASE_AUTH_EMULATOR_HOST!, email, password, facilityId: uid, rejectedFacilityId: `${uid}-reject`, staffIdToken: await auth.currentUser!.getIdToken(), assertStillPending: async () => assert.equal((await facility.get()).data()?.verificationStatus, "pending"), assertStillReceiving: assertReceivingAndDeliver, assertBrowserDelivery });
    else {
      await api.reviewFacility(uid, "verified", { checks: allChecks, verificationRecordId: "SYNTHETIC_REFERENCE" });
      await api.reviewFacility(`${uid}-reject`, "rejected", { checks: { ...allChecks, applicant: false }, verificationRecordId: "SYNTHETIC_REFERENCE", reason: "SYNTHETIC_REVIEW_PRIVATE_VALUE" });
    }
    assert.equal((await facility.get()).data()?.verificationStatus, "verified");
    assert.equal((await rejectedFacility.get()).data()?.verificationStatus, "rejected");
    assert.equal((await rejectedFacility.get()).data()?.receivingEnabled, false);
    await api.reviewFacility(`${uid}-reject`, "rejected", { checks: allChecks, verificationRecordId: "SYNTHETIC_REPEAT", reason: "SYNTHETIC_REPEAT" });
    const evidence = await api.verificationRecords(uid);
    const rejectedEvidence = await api.verificationRecords(`${uid}-reject`);
    assert.equal(evidence.items.length, 1);
    assert.equal(rejectedEvidence.items.length, 1);
    assert.equal(evidence.items[0]!.decision, "verified");
    assert.equal(rejectedEvidence.items[0]!.decision, "rejected");
    assert.ok(!JSON.stringify({ evidence, rejectedEvidence }).includes("SYNTHETIC_REFERENCE"));
    assert.ok(!JSON.stringify({ evidence, rejectedEvidence }).includes("SYNTHETIC_REVIEW_PRIVATE_VALUE"));
    if (process.env.HOSPITAL_BROWSER_SMOKE !== "true") await assertReceivingAndDeliver();
    await api.disableFacility(uid, "Synthetic emergency drill");
    const stopped = (await facility.get()).data();
    assert.equal(stopped?.receivingEnabled, false);
    assert.equal(stopped?.verificationStatus, "verified");
    const rejectedDelivery = await sendDelivery(`${patientUid}-after-stop`);
    assert.equal(rejectedDelivery.status, 412, "Stopped facility must reject a new patient delivery");
    assert.equal((await rejectedDelivery.json() as { error: { code: string } }).error.code, "PRECONDITION_FAILED");
    const patientDeliveries = await firebase.firestore.collection("deliveries").where("senderUid", "==", patientUid).get();
    assert.equal(patientDeliveries.size, expectedDeliveryCount, "Failed send must not persist another delivery");
    const originalDelivery = patientDeliveries.docs.find((doc) => doc.id === deliveredId);
    assert.ok(originalDelivery);
    assert.deepEqual(originalDelivery.data(), deliveredBeforeStop, "Stopping must leave the existing delivery unchanged");
    const replay = await sendDelivery(`${patientUid}-before-stop`);
    assert.equal(replay.status, 202, "Retry of a committed send must return the original result after stop");
    assert.equal((await replay.json() as { deliveryId: string }).deliveryId, deliveredId);
    const patientStatus = await fetch(`http://127.0.0.1:${port}/v1/deliveries/${deliveredId}`, { headers: { Authorization: `Bearer ${await patientAuth.currentUser!.getIdToken()}` } });
    assert.equal(patientStatus.status, 200);
    assert.equal((await patientStatus.json() as { status: string }).status, "delivered");
    assert.equal((await firebase.firestore.collection("deliveries").where("senderUid", "==", patientUid).get()).size, expectedDeliveryCount);
    await staffSessionSmoke({ firebase, apiBaseUrl: `http://127.0.0.1:${port}/v1`, facilityId: uid, otherFacilityId: `${uid}-reject`, deliveryId: deliveredId!, hmacSecret: loadConfig().hmacSecret });
    await hospitalTenantSmoke({ firebase, apiBaseUrl: `http://127.0.0.1:${port}/v1`, facilityId: uid, otherFacilityId: `${uid}-reject`, deliveryId: deliveredId!, hmacSecret: loadConfig().hmacSecret });
    await api.disableFacility(uid, "Synthetic repeat");
    assert.deepEqual((await facility.get()).data(), stopped, "Repeated stop must be idempotent");
    await assert.rejects(api.disableFacility(`${uid}-missing`, "Synthetic emergency drill"), { status: 404 });
    // Resume through the real API-050 route (platform-side recovery path for H-006).
    await api.enableFacility(uid);
    const reenabled = (await facility.get()).data();
    assert.equal(reenabled?.receivingEnabled, true);
    assert.equal(reenabled?.receivingDisabledBy, null);
    await membership.update({ status: "revoked" });
    await assert.rejects(api.jobFailures("ocr"), { status: 403 });
    await assert.rejects(api.disableFacility(uid, "Synthetic emergency drill"), { status: 403 });
    await assert.rejects(api.auditEvents(), { status: 403 });
    await assert.rejects(api.reviewFacilities(), { status: 403 });
    await assert.rejects(api.verificationRecords(uid), { status: 403 });
    await assert.rejects(api.reviewFacility(uid, "rejected", { checks: allChecks, verificationRecordId: "SYNTHETIC_REFERENCE", reason: "synthetic" }), { status: 403 });
    assert.equal((await facility.get()).data()?.receivingEnabled, true, "Revoked operator must not stop receiving");
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/operator/job-failures?type=ocr`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    const generatedRecords = await firebase.firestore.collection("facilityVerificationRecords").where("facilityId", "in", [uid, `${uid}-reject`]).get();
    await Promise.all(generatedRecords.docs.map((doc) => doc.ref.delete()));
    const patientDeliveries = await firebase.firestore.collection("deliveries").where("senderUid", "==", patientUid).get();
    for (const doc of patientDeliveries.docs) {
      const audit = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hmacSha256Hex(loadConfig().hmacSecret, `audit-res:${doc.id}`)).get();
      await Promise.all(audit.docs.map((event) => event.ref.delete()));
      const keyHash = doc.data().idempotencyKeyHash as string;
      await firebase.firestore.doc(`idempotencyKeys/${keyHash}`).delete();
      await doc.ref.delete();
    }
    await Promise.all([patientAccount.delete(), revision.delete(), questionnaire.delete(), ...consentFixtures.map((ref) => ref.delete()), firebase.auth.deleteUser(patientUid).catch(() => {})]);
    if (previousLegalConfig.exists) await legalConfig.set(previousLegalConfig.data()!);
    else await legalConfig.delete();
    await Promise.all([membership.delete(), browserStaffMembership.delete(), browserOtherMembership.delete(), job.delete(), facility.delete(), rejectedFacility.delete(), ...auditFixtures.map((ref) => ref.delete()), firebase.auth.deleteUser(uid).catch(() => {})]);
    await deleteApp(app);
    await deleteApp(patientApp);
    await firebase.firestore.terminate();
    const { deleteApp: deleteAdminApp } = createRequire(new URL("../../../services/api/package.json", import.meta.url))("firebase-admin/app") as { deleteApp: (app: unknown) => Promise<void> };
    await deleteAdminApp(firebase.app);
  }
});
