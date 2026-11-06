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
import type {
  QuestionnaireRevisionDoc,
} from "../../src/domain/firestoreDocs.js";

const UID = "u-intake-1";
const OTHER = "u-intake-2";

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  await seedAccount(deps, UID);
  await seedCurrentConsents(deps, UID);
  await seedAccount(deps, OTHER);
  await seedCurrentConsents(deps, OTHER);
  return { deps, app: buildTestApp(deps) };
}

function idem(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

async function createIntake(
  app: FastifyInstance,
  uid = UID,
  key = `k-${Math.random().toString(36).slice(2)}`,
): Promise<{ intakeId: string; revision: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: { ...authHeader(uid), ...idem(key) },
    payload: { locale: "ja-JP" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { intakeId: string; revision: number };
}

async function toQuestioning(
  app: FastifyInstance,
  intakeId: string,
  uid = UID,
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/symptoms`,
    headers: authHeader(uid),
    payload: {
      initialSymptomText: "3日前から頭痛",
      bodyLocations: ["head"],
      expectedIntakeRevision: 1,
    },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { revision: number }).revision;
}

async function nextQuestion(
  app: FastifyInstance,
  intakeId: string,
  rev: number,
  uid = UID,
): Promise<{ questionId: string; revision: number; topic: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/next-question`,
    headers: authHeader(uid),
    payload: { expectedIntakeRevision: rev },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    intakeRevision: number;
    question: { questionId: string; topic: string };
  };
  return {
    questionId: body.question.questionId,
    revision: body.intakeRevision,
    topic: body.question.topic,
  };
}

describe("intake routes (#11, API-009〜016)", () => {
  it("POST /intakes creates draft (201) and replays on same Idempotency-Key", async () => {
    const { app } = await setup();
    const r1 = await createIntake(app, UID, "same-key");
    const res = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      headers: { ...authHeader(UID), ...idem("same-key") },
      payload: { locale: "ja-JP" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { intakeId: string }).intakeId).toBe(r1.intakeId);
  });

  it("POST /intakes requires Idempotency-Key", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      headers: authHeader(UID),
      payload: { locale: "ja-JP" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /intakes/{id} returns detail; hides other users' intakes", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as { status: string; revision: number };
    expect(detail.status).toBe("draft");
    const other = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(OTHER),
    });
    expect(other.statusCode).toBe(404);
  });

  it("POST /symptoms transitions to questioning; validates input and revision", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    const bad = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/symptoms`,
      headers: authHeader(UID),
      payload: {
        initialSymptomText: "   ",
        bodyLocations: [],
        expectedIntakeRevision: 1,
      },
    });
    expect(bad.statusCode).toBe(400);
    const stale = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/symptoms`,
      headers: authHeader(UID),
      payload: {
        initialSymptomText: "頭痛",
        bodyLocations: ["head"],
        expectedIntakeRevision: 99,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe(
      "REVISION_CONFLICT",
    );
    const ok = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/symptoms`,
      headers: authHeader(UID),
      payload: {
        initialSymptomText: "頭痛",
        bodyLocations: ["head", "other"],
        expectedIntakeRevision: 1,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe("questioning");
  });

  it("POST /next-question returns a fixed question and persists the snapshot", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/next-question`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      question: { topic: string; generatedBy: string };
    };
    expect(body.question.topic).toBe("onset_timing");
    expect(body.question.generatedBy).toBe("fixed_template");
    // draft では 412
    const d2 = await createIntake(app);
    const early = await app.inject({
      method: "POST",
      url: `/v1/intakes/${d2.intakeId}/next-question`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: 1 },
    });
    expect(early.statusCode).toBe(412);
  });

  it("POST /answers saves answer with question revision check", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    let rev = await toQuestioning(app, intakeId);
    const q = await nextQuestion(app, intakeId, rev);
    rev = q.revision;
    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: authHeader(UID),
      payload: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        freeText: "昨日の夜から",
        answerState: "answered",
        expectedIntakeRevision: rev,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answerId: string; intakeRevision: number };
    expect(body.answerId).toBe(q.questionId);
    // 古い questionRevision は 409
    const stale = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: authHeader(UID),
      payload: {
        questionId: q.questionId,
        questionRevision: 99,
        selectedCodes: ["LT_WEEK"],
        answerState: "answered",
        expectedIntakeRevision: body.intakeRevision,
      },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("PATCH /answers/{id} edits answer (FR-I08)", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    let rev = await toQuestioning(app, intakeId);
    const q = await nextQuestion(app, intakeId, rev);
    rev = q.revision;
    const a = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: authHeader(UID),
      payload: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        answerState: "answered",
        expectedIntakeRevision: rev,
      },
    });
    const arev = (a.json() as { intakeRevision: number }).intakeRevision;
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/intakes/${intakeId}/answers/${q.questionId}`,
      headers: authHeader(UID),
      payload: {
        questionRevision: 1,
        freeText: "2日前に訂正",
        expectedIntakeRevision: arev,
      },
    });
    expect(patch.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(UID),
    });
    const answers = (detail.json() as {
      answers: Array<{ freeText: string | null }>;
    }).answers;
    expect(answers[0]?.freeText).toBe("2日前に訂正");
  });

  it("POST /summary transitions to review with FR-I07 sections", async () => {
    const { app, deps } = await setup();
    // 確認済み添付薬剤をシード（FR-M07/BR-05）
    await deps.db.doc("medications/med-1").set({
      patientUid: UID,
      displayName: "ロキソプロフェン",
      genericName: null,
      strength: "60mg",
      instructionsText: null,
      quantity: null,
      prescribedAt: null,
      currentStatus: "taking",
      confirmationStatus: "confirmed",
      sourceType: "manual",
      uploadId: null,
      ocrJobId: null,
      attachToQuestionnaire: true,
      userConfirmedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    const { intakeId } = await createIntake(app);
    let rev = await toQuestioning(app, intakeId);
    const q = await nextQuestion(app, intakeId, rev);
    rev = q.revision;
    const a = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: authHeader(UID),
      payload: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        answerState: "answered",
        expectedIntakeRevision: rev,
      },
    });
    rev = (a.json() as { intakeRevision: number }).intakeRevision;
    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      summary: {
        chiefComplaint: { value: string };
        sections: Record<string, { value: string | null }>;
        medicationSnapshots: Array<{ medicationId: string }>;
        unansweredTopics: string[];
      };
    };
    expect(body.status).toBe("review");
    expect(body.summary.chiefComplaint.value).toBe("3日前から頭痛");
    expect(body.summary.sections["onset_timing"]?.value).toContain(
      "1週間以内",
    );
    expect(body.summary.medicationSnapshots).toHaveLength(1);
    // 未出題トピックは未回答として残る（「なし」にしない）
    expect(body.summary.unansweredTopics.length).toBeGreaterThan(0);
  });

  it("POST /summary requires questioning/review state", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: 1 },
    });
    expect(res.statusCode).toBe(412);
  });

  it("POST /finalize creates immutable questionnaire revision (VAL-007)", async () => {
    const { app, deps } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    // 未レビュー（questioning）で確定 → 412
    const early = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-early") },
      payload: { expectedIntakeRevision: rev, summaryReviewConfirmed: true },
    });
    expect(early.statusCode).toBe(412);
    // summaryReviewConfirmed 未指定 → 400
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    const nocf = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-nocf") },
      payload: { expectedIntakeRevision: srev },
    });
    expect(nocf.statusCode).toBe(400);
    // 正常確定
    const fin = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-1") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    expect(fin.statusCode).toBe(200);
    const fbody = fin.json() as {
      questionnaireId: string;
      questionnaireRevision: number;
      status: string;
    };
    expect(fbody.status).toBe("finalized");
    // revision doc が immutable snapshot として保存されている
    const revDoc = (
      await deps.memDb
        .doc(`questionnaires/${fbody.questionnaireId}/revisions/1`)
        .get()
    ).data() as QuestionnaireRevisionDoc | undefined;
    expect(revDoc?.versionNumber).toBe(1);
    expect(revDoc?.schemaVersion).toBe("1");
    expect(revDoc?.rawAnswerSnapshotHash.startsWith("sha256:")).toBe(true);
    expect(revDoc?.chiefComplaint.value).toBe("3日前から頭痛");
    // intake は finalized
    const detail = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(UID),
    });
    expect((detail.json() as { status: string }).status).toBe("finalized");
    // 冪等リプレイは同一結果
    const replay = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-1") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(
      (replay.json() as { questionnaireId: string }).questionnaireId,
    ).toBe(fbody.questionnaireId);
  });

  it("POST /finalize after the reviewed summary changed returns 412", async () => {
    const { app, deps } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    // レビュー後に添付対象の確認済み薬が増えると、確定内容が要約と乖離する
    await deps.db.doc("medications/med-late").set({
      patientUid: UID,
      displayName: "カルベナ",
      genericName: null,
      strength: "200mg",
      instructionsText: null,
      quantity: null,
      prescribedAt: null,
      currentStatus: "taking",
      confirmationStatus: "confirmed",
      sourceType: "manual",
      uploadId: null,
      ocrJobId: null,
      attachToQuestionnaire: true,
      userConfirmedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    const fin = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-stale") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    expect(fin.statusCode).toBe(412);
    // 要約を再確認すれば確定できる
    const sum2 = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: srev },
    });
    const srev2 = (sum2.json() as { intakeRevision: number }).intakeRevision;
    const fin2 = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-ok") },
      payload: { expectedIntakeRevision: srev2, summaryReviewConfirmed: true },
    });
    expect(fin2.statusCode).toBe(200);
    await app.close();
  });

  it("POST /summary on an expired draft archives it and returns 412", async () => {
    const { app, deps } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    // TTL(7日)を超過させる
    deps.clock.advanceMs(8 * 24 * 60 * 60 * 1000);
    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    expect(res.statusCode).toBe(412);
    const doc = (
      await deps.memDb.doc(`intakes/${intakeId}`).get()
    ).data() as { status: string } | undefined;
    expect(doc?.status).toBe("archived");
  });

  it("POST /finalize on an expired draft archives it and returns 412", async () => {
    const { app, deps } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    deps.clock.advanceMs(8 * 24 * 60 * 60 * 1000);
    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-expired") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    expect(res.statusCode).toBe(412);
    const doc = (
      await deps.memDb.doc(`intakes/${intakeId}`).get()
    ).data() as { status: string } | undefined;
    expect(doc?.status).toBe("archived");
  });

  it("all intake endpoints reject requests without auth", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("監査イベント（#22）", () => {
  it("GET /intakes/{id} は INTAKE_READ を HMAC済み識別子付きで記録する", async () => {
    const { deps, app } = await setup();
    const { intakeId } = await createIntake(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);

    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "INTAKE_READ")
      .get();
    expect(audits.size).toBe(1);
    const ev = audits.docs[0]!.data()!;
    expect(ev.actorType).toBe("patient");
    expect(ev.resourceType).toBe("intakes");
    expect(ev.outcome).toBe("ok");
    // 生ID・生UIDを含まない（HMAC化）
    expect(ev.resourceIdHash).not.toBe(intakeId);
    expect(ev.resourceIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.actorUidHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.actorUidHash).not.toBe(UID);
    // 相関IDが伝搬している
    expect(ev.requestId).toBeTruthy();
    // PHI 非含有（症状テキスト等が混入しない）
    expect(JSON.stringify(ev)).not.toContain("頭痛");
  });

  it("他人の問診は404で INTAKE_READ を記録しない", async () => {
    const { deps, app } = await setup();
    const { intakeId } = await createIntake(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(OTHER),
    });
    expect(res.statusCode).toBe(404);
    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "INTAKE_READ")
      .get();
    expect(audits.size).toBe(0);
  });

  it("POST /finalize は INTAKE_FINALIZED を記録する", async () => {
    const { deps, app } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    const fin = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-audit") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    expect(fin.statusCode).toBe(200);
    const qid = (fin.json() as { questionnaireId: string }).questionnaireId;

    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "INTAKE_FINALIZED")
      .get();
    expect(audits.size).toBe(1);
    const ev = audits.docs[0]!.data()!;
    expect(ev.resourceType).toBe("questionnaires");
    expect(ev.resourceIdHash).not.toBe(qid);
    expect(ev.resourceIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finalize の冪等リプレイは INTAKE_FINALIZED を二重発行しない", async () => {
    const { deps, app } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    const payload = {
      expectedIntakeRevision: srev,
      summaryReviewConfirmed: true,
    };
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/intakes/${intakeId}/finalize`,
        headers: { ...authHeader(UID), ...idem("fin-replay") },
        payload,
      });
      expect(res.statusCode).toBe(200);
    }
    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "INTAKE_FINALIZED")
      .get();
    expect(audits.size).toBe(1);
  });

  it("GET /questionnaires/{id} は INTAKE_READ を記録し PHI を含まない", async () => {
    const { deps, app } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    const fin = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/finalize`,
      headers: { ...authHeader(UID), ...idem("fin-audit2") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    const qid = (fin.json() as { questionnaireId: string }).questionnaireId;

    const res = await app.inject({
      method: "GET",
      url: `/v1/questionnaires/${qid}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "INTAKE_READ")
      .where("resourceType", "==", "questionnaires")
      .get();
    expect(audits.size).toBe(1);
    const ev = audits.docs[0]!.data()!;
    expect(ev.resourceIdHash).not.toBe(qid);
    expect(JSON.stringify(ev)).not.toContain("頭痛");
  });
});
