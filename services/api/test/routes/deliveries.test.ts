import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FieldValue } from "firebase-admin/firestore";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
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
  opts: { receivingEnabled?: boolean; verificationStatus?: string } = {},
): Promise<void> {
  const ts = FieldValue.serverTimestamp();
  await deps.db.doc(`facilities/${FAC_ID}`).set({
    facilityId: FAC_ID,
    legalName: "テスト病院",
    displayName: "テスト病院",
    verificationStatus: opts.verificationStatus ?? "verified",
    receivingEnabled: opts.receivingEnabled ?? true,
    serviceAgreementVersion: "v1",
    createdAt: ts,
    updatedAt: ts,
  });
}

function deliveryPayload(questionnaireId: string, revision = 1) {
  return {
    questionnaireId,
    questionnaireRevision: revision,
    facilityId: FAC_ID,
    consentDocumentVersion: "sharing-v1",
    shareScope: {
      includeProfile: true,
      includeConfirmedMedications: true,
      includePrescriptionImages: false,
    },
  };
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
    };
    expect(body.deliveryId).toBe(deliveryId);
    expect(body.status).toBe("created");
    expect(body.facilityId).toBe(FAC_ID);
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
});
