import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";

const UID = "u-dlv-1";
const OTHER = "u-dlv-2";
const FAC_ID = "fac-test-1";

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  await seedAccount(deps, UID);
  await seedCurrentConsents(deps, UID);
  await seedAccount(deps, OTHER);
  await seedCurrentConsents(deps, OTHER);
  return { deps, app: buildTestApp(deps) };
}

/** 確定済み問診票を作成して questionnaireId を返す。 */
async function makeFinalizedQuestionnaire(app: FastifyInstance, uid = UID): Promise<string> {
  const c = await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: { ...authHeader(uid), "idempotency-key": `ik-${Math.random().toString(36).slice(2)}` },
    payload: { locale: "ja-JP" },
  });
  const { intakeId } = c.json() as { intakeId: string };

  await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/symptoms`,
    headers: authHeader(uid),
    payload: { initialSymptomText: "1週間頭が痛い", bodyLocations: ["head"], expectedIntakeRevision: 1 },
  });

  const q = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/next-question`,
    headers: authHeader(uid),
    payload: { expectedIntakeRevision: 2 },
  });
  const { questionId } = (q.json() as { question: { questionId: string } }).question;

  const a = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/answers`,
    headers: authHeader(uid),
    payload: { questionId, questionRevision: 1, selectedCodes: ["GT_WEEK"], freeText: null, answerState: "answered", expectedIntakeRevision: 3 },
  });
  const arev = (a.json() as { intakeRevision: number }).intakeRevision;

  const s = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/summary`,
    headers: authHeader(uid),
    payload: { expectedIntakeRevision: arev },
  });
  const srev = (s.json() as { intakeRevision: number }).intakeRevision;

  const f = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/finalize`,
    headers: { ...authHeader(uid), "idempotency-key": `fin-${Math.random().toString(36).slice(2)}` },
    payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
  });
  return (f.json() as { questionnaireId: string }).questionnaireId;
}

/** 施設ドキュメントをシードする。 */
async function seedFacility(
  deps: TestDeps,
  opts: { receivingEnabled?: boolean; verificationStatus?: string; syntheticDemo?: boolean; syntheticPatientUid?: string } = {},
): Promise<void> {
  const ts = FieldValue.serverTimestamp();
  await deps.db.doc(`facilities/${FAC_ID}`).set({
    facilityId: FAC_ID,
    legalName: "テスト病院",
    displayName: "テスト病院",
    verificationStatus: opts.verificationStatus ?? "verified",
    receivingEnabled: opts.receivingEnabled ?? true,
    ...(opts.syntheticDemo !== undefined ? { syntheticDemo: opts.syntheticDemo } : {}),
    ...(opts.syntheticPatientUid !== undefined ? { syntheticPatientUid: opts.syntheticPatientUid } : {}),
    serviceAgreementVersion: "v1",
    createdAt: ts,
    updatedAt: ts,
  });
}

const DISCLOSURE = DEV_LEGAL_DOCUMENTS.documents.hospital_disclosure!;
const SHARE_SCOPE = {
  includeProfile: true,
  includeConfirmedMedications: true,
  includePrescriptionImages: false,
} as const;

function deliveryPayload(questionnaireId: string, revision = 1) {
  return {
    questionnaireId,
    questionnaireRevision: revision,
    facilityId: FAC_ID,
    shareScope: { ...SHARE_SCOPE },
    consent: {
      accepted: true,
      documentVersion: DISCLOSURE.version,
      documentHash: DISCLOSURE.documentHash,
      shareScope: { ...SHARE_SCOPE },
    },
  };
}

/** 施設別同意の state doc（legalConsents/fc_{uid}_{facilityId}）をシードする。 */
async function seedFacilityConsent(
  deps: TestDeps,
  uid: string,
  opts: { decision?: "granted" | "denied"; revoked?: boolean } = {},
): Promise<string> {
  const path = `legalConsents/fc_${uid}_${FAC_ID}`;
  await deps.db.doc(path).set({
    subjectUid: uid,
    consentType: "hospital_disclosure",
    documentVersion: DISCLOSURE.version,
    documentHash: DISCLOSURE.documentHash,
    decision: opts.decision ?? "granted",
    method: "explicit_checkbox",
    registrationSource: "facility_consent",
    scope: { facilityId: FAC_ID, purpose: "medical_intake_preparation" },
    occurredAt: Timestamp.fromDate(deps.clock.now()),
    revokedAt: opts.revoked ? Timestamp.fromDate(deps.clock.now()) : null,
    schemaVersion: "1",
  });
  return path;
}

describe("delivery routes (#17, API-029/030)", () => {
  it("POST /deliveries creates delivery and returns 202 with deliveryId", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-key-1" },
      payload: deliveryPayload(qid),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { deliveryId: string; status: string };
    expect(body.status).toBe("created");
    expect(body.deliveryId).toMatch(/^dlv_/);
  });

  it("POST /deliveries は同意証跡を同一txで保存し delivery.consentId が証跡を指す (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-consent-1" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(202);
    const { deliveryId } = res.json() as { deliveryId: string };

    const delivery = (await deps.db.doc(`deliveries/${deliveryId}`).get()).data() as {
      consentId: string;
      consentDocumentVersion: string;
      consentDocumentHash: string;
      facilityConsentId: string;
    };
    // クライアント申告文字列ではなく実レコードへの参照
    expect(delivery.consentId).not.toBe("sharing-v1");
    expect(delivery.consentId).not.toBe(DISCLOSURE.version);
    expect(delivery.consentDocumentVersion).toBe(DISCLOSURE.version);
    expect(delivery.consentDocumentHash).toBe(DISCLOSURE.documentHash);
    expect(delivery.facilityConsentId).toBe(`fc_${UID}_${FAC_ID}`);

    // 送信証跡 doc: subjectUid/facilityId/revision/shareScope/deliveryId に紐づく
    const sendConsent = (
      await deps.db.doc(`legalConsents/${delivery.consentId}`).get()
    ).data() as {
      subjectUid: string;
      consentType: string;
      documentVersion: string;
      documentHash: string;
      decision: string;
      method: string;
      revokedAt: unknown;
      scope: Record<string, unknown>;
    };
    expect(sendConsent.subjectUid).toBe(UID);
    expect(sendConsent.consentType).toBe("hospital_disclosure");
    expect(sendConsent.documentVersion).toBe(DISCLOSURE.version);
    expect(sendConsent.documentHash).toBe(DISCLOSURE.documentHash);
    expect(sendConsent.decision).toBe("granted");
    expect(sendConsent.method).toBe("explicit_checkbox");
    expect(sendConsent.revokedAt).toBeNull();
    expect(sendConsent.scope).toMatchObject({
      facilityId: FAC_ID,
      questionnaireId: qid,
      questionnaireRevisionId: "1",
      deliveryId,
      // 同意した範囲と実際に送信した範囲は別々に記録される
      shareScope: SHARE_SCOPE,
      sentShareScope: SHARE_SCOPE,
    });
    expect(sendConsent.scope["facilityConsentId"]).toBe(`fc_${UID}_${FAC_ID}`);

    // (uid, facilityId) 単位の同意 state doc も granted で保存される
    const state = (
      await deps.db.doc(`legalConsents/fc_${UID}_${FAC_ID}`).get()
    ).data() as {
      decision: string;
      revokedAt: unknown;
      registrationSource: string;
      scope: Record<string, unknown>;
    };
    expect(state.decision).toBe("granted");
    expect(state.revokedAt).toBeNull();
    expect(state.registrationSource).toBe("facility_consent");
    expect(state.scope).toMatchObject({
      facilityId: FAC_ID,
      lastDeliveryId: deliveryId,
      lastConsentId: delivery.consentId,
    });
  });

  it("POST /deliveries は includeProfile 同意時に本人確認スナップショットと表示名を保存する", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);
    const ts = FieldValue.serverTimestamp();
    await deps.db.doc(`patientProfiles/${UID}`).set({
      patientUid: UID,
      familyName: "山田",
      givenName: "太郎",
      familyNameKana: "やまだ",
      givenNameKana: "たろう",
      birthDate: "1980-01-01",
      phoneNumber: "090-0000-0000",
      locale: "ja-JP",
      profileComplete: true,
      updatedAt: ts,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-key-identity" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(202);
    const { deliveryId } = res.json() as { deliveryId: string };
    const doc = (await deps.db.doc(`deliveries/${deliveryId}`).get()).data() as {
      patientIdentitySnapshot: Record<string, unknown>;
      patientDisplayName: string | null;
    };
    expect(doc.patientIdentitySnapshot).toMatchObject({
      familyName: "山田",
      givenName: "太郎",
      birthDate: "1980-01-01",
      phoneNumber: "090-0000-0000",
    });
    expect(doc.patientDisplayName).toBe("山田 太郎");
  });

  it("POST /deliveries は includeProfile 非同意なら本人確認情報を保存しない", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);
    await deps.db.doc(`patientProfiles/${UID}`).set({
      patientUid: UID,
      familyName: "山田",
      givenName: "太郎",
      locale: "ja-JP",
      profileComplete: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-key-noprofile" },
      payload: {
        ...deliveryPayload(qid),
        shareScope: {
          includeProfile: false,
          includeConfirmedMedications: true,
          includePrescriptionImages: false,
        },
      },
    });
    expect(res.statusCode).toBe(202);
    const { deliveryId } = res.json() as { deliveryId: string };
    const doc = (await deps.db.doc(`deliveries/${deliveryId}`).get()).data() as {
      patientIdentitySnapshot: Record<string, unknown>;
      patientDisplayName: string | null;
    };
    expect(doc.patientIdentitySnapshot).toEqual({});
    expect(doc.patientDisplayName).toBeNull();
  });

  it("POST /deliveries is idempotent — same key returns same deliveryId", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const payload = deliveryPayload(qid);
    const headers = { ...authHeader(UID), "idempotency-key": "dlv-idem-key" };

    const r1 = await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload });
    const r2 = await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload });

    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    // 同一Idempotency-Keyで同一結果が返る
    expect(r1.json<{ deliveryId: string }>().deliveryId).toBe(
      r2.json<{ deliveryId: string }>().deliveryId,
    );
  });

  it("POST /deliveries returns 409 for same key but different payload", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const headers = { ...authHeader(UID), "idempotency-key": "dlv-conflict-key" };
    const r1 = await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload: deliveryPayload(qid) });
    expect(r1.statusCode).toBe(202);

    // 異なるペイロード（別 questionnaireRevision）で同じキー
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers,
      payload: { ...deliveryPayload(qid), questionnaireRevision: 999 },
    });
    expect(r2.statusCode).toBe(409);
  });

  it("POST /deliveries returns 400 when Idempotency-Key header is missing", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: authHeader(UID),
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /deliveries returns 404 when questionnaire does not exist", async () => {
    const { deps, app } = await setup();
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-noqn" },
      payload: deliveryPayload("nonexistent-qn"),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /deliveries returns 403 when questionnaire belongs to another user", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app, OTHER);
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-other" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /deliveries returns 412 when facility is not verified (E2E-006 variant)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps, { verificationStatus: "pending" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-unver" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(412);
  });

  it("allows pending synthetic demo delivery only for its server-configured synthetic patient", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps, {
      verificationStatus: "pending",
      syntheticDemo: true,
      syntheticPatientUid: UID,
    });
    await deps.db.doc(`syntheticDemoPatients/${UID}`).set({ facilityId: FAC_ID });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-synthetic-match" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(202);
  });

  it.each(["other-patient", "flag-off", "unverified-email", "verified-marker"])("self-service delivery denies %s", async (scenario) => {
    const deps = makeTestDeps({ syntheticSelfServiceEnabled: true });
    await seedLegalDocuments(deps);
    for (const uid of [UID, OTHER]) {
      await seedAccount(deps, uid);
      await seedCurrentConsents(deps, uid);
    }
    const app = buildTestApp(deps);
    const started = await app.inject({ method: "POST", url: "/v1/me/synthetic-demo", headers: authHeader(UID), payload: { syntheticDataOnly: true } });
    expect(started.statusCode).toBe(200);
    const facilityId = started.json().facilityId;
    const sender = scenario === "other-patient" ? OTHER : UID;
    const qid = await makeFinalizedQuestionnaire(app, sender);
    if (scenario === "flag-off") deps.config = { ...deps.config, syntheticSelfServiceEnabled: false };
    if (scenario === "verified-marker") await deps.db.doc(`facilities/${facilityId}`).update({ verificationStatus: "verified" });
    if (scenario === "unverified-email") deps.auth = { verifyIdToken: async () => ({ uid: UID, authTimeSeconds: 1, emailVerified: false, signInProvider: "password", providers: ["password"] }) };
    const res = await app.inject({ method: "POST", url: "/v1/deliveries", headers: { ...authHeader(sender), "idempotency-key": `self-denial-${scenario}` }, payload: { ...deliveryPayload(qid), facilityId } });
    expect(res.statusCode).toBe(scenario === "unverified-email" ? 403 : 412);
    expect((await deps.db.collection("deliveries").get()).empty).toBe(true);
    await app.close();
  });

  it("rejects a matching synthetic patient when receiving is disabled", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps, { verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: UID, receivingEnabled: false });
    await deps.db.doc(`syntheticDemoPatients/${UID}`).set({ facilityId: FAC_ID });
    const res = await app.inject({ method: "POST", url: "/v1/deliveries", headers: { ...authHeader(UID), "idempotency-key": "dlv-synthetic-stopped" }, payload: deliveryPayload(qid) });
    expect(res.statusCode).toBe(412);
  });

  it.each([
    { syntheticDemo: false, syntheticPatientUid: UID },
    { syntheticDemo: true, syntheticPatientUid: OTHER },
    { syntheticDemo: true },
  ])("rejects pending facility when synthetic demo identity does not match (%o)", async (markers) => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps, { verificationStatus: "pending", ...markers });
    await deps.db.doc(`syntheticDemoPatients/${UID}`).set({ facilityId: FAC_ID });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": `dlv-synthetic-deny-${Math.random()}` },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(412);
  });

  it.each([undefined, {}, { facilityId: "other" }])("rejects missing or mismatched patient binding %o", async (binding) => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps, { verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: UID });
    if (binding) await deps.db.doc(`syntheticDemoPatients/${UID}`).set(binding);
    const res = await app.inject({ method: "POST", url: "/v1/deliveries", headers: { ...authHeader(UID), "idempotency-key": "dlv-binding-deny" }, payload: deliveryPayload(qid) });
    expect(res.statusCode).toBe(412);
  });

  it("POST /deliveries returns 412 when facility has receivingEnabled=false (E2E-006)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps, { receivingEnabled: false });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-disabled" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(412);

    // 同意検証以外の 412 は DELIVERY_REJECTED 監査を出さない（責務の分離）
    const audits = await deps.db.collection("auditEvents").get();
    expect(
      audits.docs.filter((d) => d.data()["action"] === "DELIVERY_REJECTED"),
    ).toHaveLength(0);
  });

  it.each([
    ["consent.accepted=false", "not-accepted", "consent_not_accepted",
      (p: Record<string, unknown>) => ({
        ...p, consent: { ...(p["consent"] as object), accepted: false },
      })],
    ["documentVersion が旧版", "stale-version", "document_version_mismatch",
      (p: Record<string, unknown>) => ({
        ...p, consent: { ...(p["consent"] as object), documentVersion: "2020-01-01" },
      })],
    ["documentHash 不一致", "hash-mismatch", "document_hash_mismatch",
      (p: Record<string, unknown>) => ({
        ...p, consent: { ...(p["consent"] as object), documentHash: "sha256:deadbeef" },
      })],
    ["shareScope が同意範囲を超過", "scope-exceeds", "share_scope_exceeds_consent",
      (p: Record<string, unknown>) => ({
        ...p,
        shareScope: { ...SHARE_SCOPE, includePrescriptionImages: true },
      })],
  ])("POST /deliveries returns 412 + DELIVERY_REJECTED audit when %s (#219)", async (_name, key, expectedReason, mutate) => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const payload = mutate(deliveryPayload(qid) as unknown as Record<string, unknown>);
    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": `dlv-deny-${key}` },
      payload,
    });
    expect(res.statusCode).toBe(412);

    // 副作用なし（配送・同意証跡ともに残らない）
    const deliveries = await deps.db.collection("deliveries").get();
    expect(deliveries.empty).toBe(true);

    const audits = await deps.db.collection("auditEvents").get();
    const rejections = audits.docs
      .map((d) => d.data())
      .filter((e) => e["action"] === "DELIVERY_REJECTED");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!["decision"]).toBe("deny");
    expect(rejections[0]!["facilityId"]).toBe(FAC_ID);
    const details = rejections[0]!["details"] as Record<string, unknown>;
    expect(details["reason"]).toBe(expectedReason);
    // 監査証跡として申告された版/hash を記録する
    expect(details["documentVersion"]).toBeTruthy();
    expect(details["documentHash"]).toBeTruthy();
    // PHI・生IDを含めない
    expect(rejections[0]!["actorUidHash"]).not.toBe(UID);
  });

  it("POST /deliveries returns 412 when 施設別同意が撤回済み (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);
    await seedFacilityConsent(deps, UID, { revoked: true });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-revoked" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(412);
    const deliveries = await deps.db.collection("deliveries").get();
    expect(deliveries.empty).toBe(true);
    const audits = await deps.db.collection("auditEvents").get();
    const rejections = audits.docs
      .map((d) => d.data())
      .filter((e) => e["action"] === "DELIVERY_REJECTED");
    expect(rejections).toHaveLength(1);
    expect((rejections[0]!["details"] as Record<string, unknown>)["reason"]).toBe(
      "facility_consent_revoked",
    );
  });

  it("POST /deliveries returns 412 when 施設別同意が denied (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);
    await seedFacilityConsent(deps, UID, { decision: "denied" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-denied" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(412);
    const deliveries = await deps.db.collection("deliveries").get();
    expect(deliveries.empty).toBe(true);
  });

  it("POST /deliveries returns 412 when fc_ doc の主体/施設が不一致 (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);
    // ID が衝突した他主体の同意 doc（scope.facilityId がリクエストと異なる）
    await deps.db.doc(`legalConsents/fc_${UID}_${FAC_ID}`).set({
      subjectUid: OTHER,
      consentType: "hospital_disclosure",
      documentVersion: DISCLOSURE.version,
      documentHash: DISCLOSURE.documentHash,
      decision: "granted",
      method: "explicit_checkbox",
      registrationSource: "facility_consent",
      scope: { facilityId: "fac-other", purpose: "medical_intake_preparation" },
      occurredAt: Timestamp.fromDate(deps.clock.now()),
      revokedAt: null,
      schemaVersion: "1",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-mismatched" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(412);
    const deliveries = await deps.db.collection("deliveries").get();
    expect(deliveries.empty).toBe(true);
  });

  it("POST /deliveries returns 400 when consent フィールドが欠落 (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const payload = deliveryPayload(qid) as unknown as Record<string, unknown>;
    delete payload["consent"];
    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-no-consent" },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("冪等リプレイで同意証跡を重複生成しない (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const headers = { ...authHeader(UID), "idempotency-key": "dlv-idem-consent" };
    const payload = deliveryPayload(qid);
    const r1 = await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload });
    const r2 = await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);

    // hospital_disclosure の同意証跡は state doc + 送信証跡の 2 件のみ
    const consents = await deps.db
      .collection("legalConsents")
      .where("consentType", "==", "hospital_disclosure")
      .get();
    expect(consents.size).toBe(2);
  });

  it("別の冪等キーでの再送信は state doc の最新参照を更新し送信証跡は1送信1件 (#219)", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);
    const payload = deliveryPayload(qid);

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-resend-1" },
      payload,
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-resend-2" },
      payload,
    });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    const dlv1 = r1.json<{ deliveryId: string }>().deliveryId;
    const dlv2 = r2.json<{ deliveryId: string }>().deliveryId;
    expect(dlv1).not.toBe(dlv2);

    // state doc は1件のまま、最新の送信を指す
    const state = (
      await deps.db.doc(`legalConsents/fc_${UID}_${FAC_ID}`).get()
    ).data() as { scope: { lastDeliveryId?: string } };
    expect(state.scope.lastDeliveryId).toBe(dlv2);

    // 送信証跡は送信ごとに1件ずつ（state doc + 証跡2件 = 3件）
    const consents = await deps.db
      .collection("legalConsents")
      .where("consentType", "==", "hospital_disclosure")
      .get();
    expect(consents.size).toBe(3);
    const evidenceDocs = consents.docs.filter(
      (d) => d.data()["registrationSource"] === "delivery_send",
    );
    expect(evidenceDocs).toHaveLength(2);
    const evidenceDeliveryIds = evidenceDocs
      .map((d) => (d.data()["scope"] as Record<string, unknown>)["deliveryId"])
      .sort();
    expect(evidenceDeliveryIds).toEqual([dlv1, dlv2].sort());
  });

  it("GET /deliveries/:id returns delivery status for sender", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const created = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-get-1" },
      payload: deliveryPayload(qid),
    });
    const { deliveryId } = created.json() as { deliveryId: string };

    const res = await app.inject({
      method: "GET",
      url: `/v1/deliveries/${deliveryId}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deliveryId: string;
      status: string;
      facilityId: string;
      consentId: string;
    };
    expect(body.deliveryId).toBe(deliveryId);
    // 施設側コピーは作成=配送済み（created→delivered はtx内で完結）
    expect(body.status).toBe("delivered");
    expect(body.facilityId).toBe(FAC_ID);
    // consentId は本送信の同意証跡 doc を指す（#219）
    const sendConsent = await deps.db
      .doc(`legalConsents/${body.consentId}`)
      .get();
    expect(sendConsent.exists).toBe(true);
    expect(
      (sendConsent.data() as { scope: { deliveryId?: string } }).scope
        .deliveryId,
    ).toBe(deliveryId);
  });

  it("GET /deliveries/:id returns 404 for another user's delivery", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const created = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-get-other" },
      payload: deliveryPayload(qid),
    });
    const { deliveryId } = created.json() as { deliveryId: string };

    const res = await app.inject({
      method: "GET",
      url: `/v1/deliveries/${deliveryId}`,
      headers: authHeader(OTHER),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /deliveries/:id returns 404 for nonexistent delivery", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/deliveries/nonexistent-id",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(404);
  });

  it("配送作成で DELIVERY_CREATED 監査が記録され requestId が伝搬する", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(UID), "idempotency-key": "dlv-audit-1" },
      payload: deliveryPayload(qid),
    });
    expect(res.statusCode).toBe(202);
    const { deliveryId } = res.json() as { deliveryId: string };

    const audits = await deps.db.collection("auditEvents").get();
    const events = audits.docs
      .map((d) => d.data())
      .filter((e) => e["action"] === "DELIVERY_CREATED");
    expect(events).toHaveLength(1);
    expect(events[0]!["facilityId"]).toBe(FAC_ID);
    expect(events[0]!["requestId"]).toBeTruthy();
    // 生IDは保存しない
    expect(events[0]!["resourceIdHash"]).not.toBe(deliveryId);
    expect(events[0]!["actorUidHash"]).not.toBe(UID);
  });

  it("冪等リプレイでは DELIVERY_CREATED 監査を重複発行しない", async () => {
    const { deps, app } = await setup();
    const qid = await makeFinalizedQuestionnaire(app);
    await seedFacility(deps);

    const headers = { ...authHeader(UID), "idempotency-key": "dlv-audit-idem" };
    const payload = deliveryPayload(qid);
    await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload });
    await app.inject({ method: "POST", url: "/v1/deliveries", headers, payload });

    const audits = await deps.db.collection("auditEvents").get();
    const events = audits.docs
      .map((d) => d.data())
      .filter((e) => e["action"] === "DELIVERY_CREATED");
    expect(events).toHaveLength(1);
  });
});
