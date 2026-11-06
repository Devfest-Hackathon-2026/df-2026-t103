import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import { Timestamp } from "firebase-admin/firestore";

const UID = "u-qn-1";
const OTHER = "u-qn-2";

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  await seedAccount(deps, UID);
  await seedCurrentConsents(deps, UID);
  await seedAccount(deps, OTHER);
  await seedCurrentConsents(deps, OTHER);
  return { deps, app: buildTestApp(deps) };
}

/** API-009〜016 の実フローで確定済み問診票を作る。 */
async function finalizedQuestionnaire(
  app: FastifyInstance,
  uid = UID,
): Promise<string> {
  const c = await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: {
      ...authHeader(uid),
      "idempotency-key": `k-${Math.random().toString(36).slice(2)}`,
    },
    payload: { locale: "ja-JP" },
  });
  const { intakeId } = c.json() as { intakeId: string };
  await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/symptoms`,
    headers: authHeader(uid),
    payload: {
      initialSymptomText: "2週間夕方になるとだるい",
      bodyLocations: ["whole_body"],
      expectedIntakeRevision: 1,
    },
  });
  const q = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/next-question`,
    headers: authHeader(uid),
    payload: { expectedIntakeRevision: 2 },
  });
  const { questionId } = (
    q.json() as { question: { questionId: string } }
  ).question;
  const a = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/answers`,
    headers: authHeader(uid),
    payload: {
      questionId,
      questionRevision: 1,
      selectedCodes: ["GT_WEEK"],
      freeText: "2週間ほど前から",
      answerState: "answered",
      expectedIntakeRevision: 3,
    },
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
    headers: {
      ...authHeader(uid),
      "idempotency-key": `fin-${Math.random().toString(36).slice(2)}`,
    },
    payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
  });
  return (f.json() as { questionnaireId: string }).questionnaireId;
}

describe("questionnaire routes (#12, API-017/018)", () => {
  it("GET /questionnaires returns only the owner's past tickets", async () => {
    const { app } = await setup();
    const qid = await finalizedQuestionnaire(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/questionnaires",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as {
      questionnaires: Array<{ questionnaireId: string }>;
    }).questionnaires;
    expect(list.map((q) => q.questionnaireId)).toContain(qid);
    const other = await app.inject({
      method: "GET",
      url: "/v1/questionnaires",
      headers: authHeader(OTHER),
    });
    expect(
      (other.json() as { questionnaires: unknown[] }).questionnaires,
    ).toHaveLength(0);
  });

  it("GET /questionnaires/{id} returns the finalized snapshot with hash", async () => {
    const { app } = await setup();
    const qid = await finalizedQuestionnaire(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/questionnaires/${qid}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      latestRevision: number;
      revisions: Array<{ versionNumber: number }>;
      revision: {
        versionNumber: number;
        chiefComplaint: { value: string };
        sections: Record<string, { value: string | null }>;
        rawAnswerSnapshotHash: string;
        unansweredTopics: string[];
      };
    };
    expect(body.status).toBe("finalized");
    expect(body.latestRevision).toBe(1);
    expect(body.revisions).toHaveLength(1);
    expect(body.revision.chiefComplaint.value).toBe(
      "2週間夕方になるとだるい",
    );
    expect(
      body.revision.rawAnswerSnapshotHash.startsWith("sha256:"),
    ).toBe(true);
    expect(
      body.revision.sections["onset_timing"]?.value,
    ).toContain("2週間ほど前から");
    expect(body.revision.unansweredTopics.length).toBeGreaterThan(0);
  });

  it("GET /questionnaires/{id}?revision=N fetches an immutable past revision; out-of-range → 404", async () => {
    const { app, deps } = await setup();
    const qid = await finalizedQuestionnaire(app);
    // 2版目を直接シードして過去版アクセスを検証
    await deps.db
      .doc(`questionnaires/${qid}/revisions/2`)
      .set({
        versionNumber: 2,
        patientUid: UID,
        schemaVersion: "1",
        chiefComplaint: { value: "修正版", source: "patient" },
        sections: {},
        bodyLocations: [],
        medicalHistorySnapshot: [],
        medicationSnapshots: [],
        unansweredTopics: [],
        rawAnswerSnapshotHash: "sha256:rev2",
        summaryReviewConfirmedAt: Timestamp.now(),
        createdAt: Timestamp.now(),
      });
    await deps.db.doc(`questionnaires/${qid}`).update({ latestRevision: 2 });
    const v2 = await app.inject({
      method: "GET",
      url: `/v1/questionnaires/${qid}?revision=2`,
      headers: authHeader(UID),
    });
    expect(v2.statusCode).toBe(200);
    expect(
      (v2.json() as { revision: { versionNumber: number } }).revision
        .versionNumber,
    ).toBe(2);
    // デフォルトは最新版
    const latest = await app.inject({
      method: "GET",
      url: `/v1/questionnaires/${qid}`,
      headers: authHeader(UID),
    });
    expect(
      (latest.json() as { revision: { versionNumber: number } }).revision
        .versionNumber,
    ).toBe(2);
    expect(
      (latest.json() as { revisions: unknown[] }).revisions,
    ).toHaveLength(2);
    // 範囲外 → 404
    const oob = await app.inject({
      method: "GET",
      url: `/v1/questionnaires/${qid}?revision=9`,
      headers: authHeader(UID),
    });
    expect(oob.statusCode).toBe(404);
  });

  it("hides other users' questionnaires (404)", async () => {
    const { app } = await setup();
    const qid = await finalizedQuestionnaire(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/questionnaires/${qid}`,
      headers: authHeader(OTHER),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a nonexistent questionnaire and 401 unauthenticated", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/questionnaires/qn-missing",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(404);
    const unauth = await app.inject({
      method: "GET",
      url: "/v1/questionnaires",
    });
    expect(unauth.statusCode).toBe(401);
  });
});
