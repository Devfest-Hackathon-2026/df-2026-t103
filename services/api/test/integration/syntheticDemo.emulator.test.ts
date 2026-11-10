import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AdminAuthVerifier } from "../../src/auth/verifiers.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import { deleteSelfServiceDemo, selfServiceFacilityId } from "../../src/services/syntheticDemo.js";
import { authHeader, buildTestApp, seedAccount, seedCurrentConsents, seedLegalDocuments } from "../helpers/app.js";
import { clearEmulatorAuth, clearEmulatorFirestore, makeEmulatorDeps, type EmulatorDeps } from "../helpers/emulator.js";

describe("self-service synthetic demo / real Auth + Firestore emulator", () => {
  let deps: EmulatorDeps;
  let app: FastifyInstance;
  beforeEach(async () => {
    await clearEmulatorFirestore();
    await clearEmulatorAuth();
    deps = makeEmulatorDeps({ realAuth: true, config: { syntheticSelfServiceEnabled: true } });
    await seedLegalDocuments(deps);
    app = buildTestApp(deps);
  });
  afterEach(async () => {
    await app.close();
    await clearEmulatorFirestore();
    await clearEmulatorAuth();
  });

  it("cleanup of unsupported binding version never deletes either document or reports empty on retry", async () => {
    const uid = "cleanup-patient";
    await seedAccount(deps, uid);
    await seedCurrentConsents(deps, uid);
    const started = await app.inject({ method: "POST", url: "/v1/me/synthetic-demo", headers: authHeader(uid), payload: { syntheticDataOnly: true } });
    expect(started.statusCode).toBe(200);
    const facilityRef = deps.firestore.doc(`facilities/${selfServiceFacilityId(uid)}`);
    const bindingRef = deps.firestore.doc(`syntheticDemoPatients/${uid}`);
    await bindingRef.update({ selfServiceVersion: 2 });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(deleteSelfServiceDemo(deps, uid)).rejects.toMatchObject({ statusCode: 409 });
      expect((await facilityRef.get()).exists).toBe(true);
      expect((await bindingRef.get()).data()?.selfServiceVersion).toBe(2);
    }
    await facilityRef.delete(); // emulate the old partial-deletion state
    await expect(deleteSelfServiceDemo(deps, uid)).rejects.toMatchObject({ statusCode: 409 });
    expect((await bindingRef.get()).exists).toBe(true);
  });

  it("real registration → email confirmation → profile → explicit opt-in → intake → consent → stored delivery, no hospital access", async () => {
    deps.auth = new AdminAuthVerifier(deps.emulatorAuth!);
    const email = "synthetic-reviewer@example.test", password = "SyntheticOnly1234";
    const registered = await app.inject({ method: "POST", url: "/v1/auth/register", headers: { "idempotency-key": "synthetic-register" },
      payload: { email, password, locale: "ja-JP", consents: Object.fromEntries(DEV_LEGAL_DOCUMENTS.requiredConsents.map((type) =>
        [type, { accepted: true, documentVersion: DEV_LEGAL_DOCUMENTS.documents[type]!.version }])) } });
    expect(registered.statusCode).toBe(201);
    const uid = (await deps.emulatorAuth!.getUserByEmail(email)).uid;
    // helper validation above guarantees loopback; no real email is sent.
    const authUrl = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
    async function signIn() {
      const res = await fetch(`${authUrl}/accounts:signInWithPassword?key=synthetic-only`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      expect(res.ok).toBe(true);
      return { authorization: `Bearer ${(await res.json() as { idToken: string }).idToken}` };
    }
    let headers = await signIn();
    const start = () => app.inject({ method: "POST", url: "/v1/me/synthetic-demo", headers, payload: { syntheticDataOnly: true } });
    expect((await start()).statusCode).toBe(403);
    const link = await deps.emulatorAuth!.generateEmailVerificationLink(email);
    const oobCode = new URL(link).searchParams.get("oobCode");
    expect(oobCode).toBeTruthy();
    const confirmed = await fetch(`${authUrl}/accounts:update?key=synthetic-only`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ oobCode }) });
    expect(confirmed.ok).toBe(true);
    headers = await signIn();
    expect((await start()).statusCode).toBe(403); // profile still required
    const profile = await app.inject({ method: "PATCH", url: "/v1/me/profile", headers,
      payload: { familyName: "合成", givenName: "審査", familyNameKana: "ゴウセイ", givenNameKana: "シンサ",
        birthDate: "1990-01-01", phoneNumber: "09000000000", postalCode: "1000001",
        address: { prefecture: "東京都", city: "架空市", line1: "架空1-1" } } });
    expect(profile.statusCode).toBe(200);
    const started = await start();
    expect(started.statusCode).toBe(200);
    const facilityId = started.json().facilityId;
    expect(facilityId).toBe(selfServiceFacilityId(uid));
    const detail = await app.inject({ method: "GET", url: `/v1/facilities/${facilityId}`, headers });
    expect(detail.json()).toMatchObject({ syntheticRecipient: true, syntheticStorageOnly: true, verificationStatus: "pending" });
    const create = await app.inject({ method: "POST", url: "/v1/intakes", headers: { ...headers, "idempotency-key": "demo-intake" }, payload: { locale: "ja-JP" } });
    expect(create.statusCode).toBe(201);
    const intakeId = create.json().intakeId;
    expect((await app.inject({ method: "POST", url: `/v1/intakes/${intakeId}/symptoms`, headers,
      payload: { initialSymptomText: "合成デモ：1週間頭が痛い", bodyLocations: ["head"], expectedIntakeRevision: 1 } })).statusCode).toBe(200);
    const question = await app.inject({ method: "POST", url: `/v1/intakes/${intakeId}/next-question`, headers, payload: { expectedIntakeRevision: 2 } });
    expect(question.statusCode).toBe(200);
    const answer = await app.inject({ method: "POST", url: `/v1/intakes/${intakeId}/answers`, headers,
      payload: { questionId: question.json().question.questionId, questionRevision: 1, selectedCodes: ["GT_WEEK"], answerState: "answered", expectedIntakeRevision: 3 } });
    expect(answer.statusCode).toBe(200);
    const summary = await app.inject({ method: "POST", url: `/v1/intakes/${intakeId}/summary`, headers, payload: { expectedIntakeRevision: answer.json().intakeRevision } });
    expect(summary.statusCode).toBe(200);
    const finalized = await app.inject({ method: "POST", url: `/v1/intakes/${intakeId}/finalize`, headers: { ...headers, "idempotency-key": "demo-finalize" },
      payload: { expectedIntakeRevision: summary.json().intakeRevision, summaryReviewConfirmed: true } });
    expect(finalized.statusCode).toBe(200);
    const scope = { includeProfile: false, includeConfirmedMedications: false, includePrescriptionImages: false };
    const disclosure = DEV_LEGAL_DOCUMENTS.documents.hospital_disclosure!;
    const payload = { facilityId, questionnaireId: finalized.json().questionnaireId, questionnaireRevision: 1, shareScope: scope,
      consent: { accepted: true, documentVersion: disclosure.version, documentHash: disclosure.documentHash, shareScope: scope } };
    expect((await app.inject({ method: "POST", url: "/v1/deliveries", headers: { ...headers, "idempotency-key": "demo-no-consent" },
      payload: { ...payload, consent: { ...payload.consent, accepted: false } } })).statusCode).toBe(412);
    const delivered = await app.inject({ method: "POST", url: "/v1/deliveries", headers: { ...headers, "idempotency-key": "demo-delivery" }, payload });
    expect(delivered.statusCode).toBe(202);
    const replay = await app.inject({ method: "POST", url: "/v1/deliveries", headers: { ...headers, "idempotency-key": "demo-delivery" }, payload });
    expect(replay.json().deliveryId).toBe(delivered.json().deliveryId);
    const stored = await deps.firestore.doc(`deliveries/${delivered.json().deliveryId}`).get();
    expect(stored.data()).toMatchObject({ senderUid: uid, facilityId, status: "delivered" });
    expect((await deps.firestore.collection("facilityMemberships").get()).empty).toBe(true);
    expect((await app.inject({ method: "GET", url: `/v1/hospitals/${facilityId}/deliveries`, headers })).statusCode).toBe(403);
    expect((await deps.firestore.doc(`facilities/${facilityId}`).get()).data()?.verificationStatus).toBe("pending");
  });

  it("concurrent requests and transient transaction failure converge to one pair; quota is atomic", async () => {
    for (const uid of ["demo-a", "demo-b"]) {
      await seedAccount(deps, uid);
      await seedCurrentConsents(deps, uid);
    }
    const start = (uid: string) => app.inject({ method: "POST", url: "/v1/me/synthetic-demo", headers: authHeader(uid), payload: { syntheticDataOnly: true } });
    const original = deps.db.runTransaction.bind(deps.db);
    deps.db.runTransaction = (callback, options) => original(async (tx) => {
      await callback(tx);
      throw new Error("synthetic pre-commit failure");
    }, options);
    expect((await start("demo-a")).statusCode).toBe(500);
    expect((await deps.firestore.collection("facilities").get()).empty).toBe(true);
    expect((await deps.firestore.collection("syntheticDemoPatients").get()).empty).toBe(true);
    expect((await deps.firestore.doc("syntheticDemoProvisioning/selfService").get()).exists).toBe(false);
    deps.db.runTransaction = original;
    deps.flakyDb.failNextTransactions = 1;
    expect((await start("demo-a")).statusCode).toBe(500);
    expect((await deps.firestore.collection("facilities").get()).empty).toBe(true);
    const same = await Promise.all([start("demo-a"), start("demo-a"), start("demo-a")]);
    expect(same.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(same.map((r) => r.json().facilityId)).size).toBe(1);
    expect((await deps.firestore.doc("syntheticDemoProvisioning/selfService").get()).data()?.createdCount).toBe(1);
    // New config, same persistent counter: cap cannot be bypassed by another instance.
    const capped = buildTestApp({ ...deps, config: { ...deps.config, syntheticSelfServiceMaxFacilities: 1 } });
    expect((await capped.inject({ method: "POST", url: "/v1/me/synthetic-demo", headers: authHeader("demo-b"), payload: { syntheticDataOnly: true } })).statusCode).toBe(412);
    await capped.close();
    expect((await deps.firestore.collection("facilities").get()).size).toBe(1);
    expect((await deps.firestore.doc("syntheticDemoPatients/demo-b").get()).exists).toBe(false);
  });

  it("two different patients racing for the last quota slot cannot exceed it", async () => {
    for (const uid of ["quota-a", "quota-b"]) {
      await seedAccount(deps, uid);
      await seedCurrentConsents(deps, uid);
    }
    const capped = buildTestApp({ ...deps, config: { ...deps.config, syntheticSelfServiceMaxFacilities: 1 } });
    try {
      const results = await Promise.all(["quota-a", "quota-b"].map((uid) => capped.inject({ method: "POST", url: "/v1/me/synthetic-demo",
        headers: authHeader(uid), payload: { syntheticDataOnly: true } })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
      expect((await deps.firestore.collection("facilities").get()).size).toBe(1);
      expect((await deps.firestore.collection("syntheticDemoPatients").get()).size).toBe(1);
      expect((await deps.firestore.doc("syntheticDemoProvisioning/selfService").get()).data()?.createdCount).toBe(1);
    } finally {
      await capped.close();
    }
  });
});
