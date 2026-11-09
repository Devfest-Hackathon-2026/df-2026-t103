import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import type { AppConfig } from "../../src/config.js";
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

async function setup(
  configOverrides: Partial<AppConfig> = {},
): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps(configOverrides);
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
  symptoms: { initialSymptomText: string; bodyLocations: string[] } = {
    initialSymptomText: "3日前から頭痛",
    bodyLocations: ["head"],
  },
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/symptoms`,
    headers: authHeader(uid),
    payload: {
      ...symptoms,
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

  it("POST /next-question passes synthetic symptoms to the enabled LLM and reports llm", async () => {
    const { app, deps } = await setup({ aiIntakeEnabled: true });
    deps.fakeLlm.result = {
      questions: [
        {
          questionText: "合成症状について、いつから痛みが続いていますか？",
          topic: "onset_timing",
          options: [
            { code: "LT_DAY", label: "1日未満" },
            { code: "LT_WEEK", label: "1週間未満" },
          ],
        },
      ],
      modelVersion: "synthetic-test-v1",
    };
    const { intakeId } = await createIntake(app);
    const symptomText = "テスト専用の合成症状：左手の軽い違和感";
    const bodyLocations = ["left_hand"];
    const rev = await toQuestioning(app, intakeId, UID, {
      initialSymptomText: symptomText,
      bodyLocations,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/next-question`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });

    expect(res.statusCode).toBe(200);
    expect(deps.fakeLlm.calls).toHaveLength(1);
    expect(deps.fakeLlm.calls[0]).toMatchObject({
      symptomText,
      bodyLocations,
    });
    expect(res.json()).toMatchObject({
      question: {
        questionText: "合成症状について、いつから痛みが続いていますか？",
        generatedBy: "llm",
        modelVersion: "synthetic-test-v1",
      },
    });
    expect(
      (res.json() as { question: { generatedBy: string } }).question.generatedBy,
    ).not.toBe("fixed_template");
  });

  it("POST /next-question reports fallback when the enabled LLM fails", async () => {
    const { app, deps } = await setup({ aiIntakeEnabled: true });
    deps.fakeLlm.shouldThrow = new Error("synthetic LLM failure");
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/next-question`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });

    expect(res.statusCode).toBe(200);
    expect(deps.fakeLlm.calls).toHaveLength(1);
    expect(res.json()).toMatchObject({
      question: {
        topic: "onset_timing",
        generatedBy: "fallback",
      },
    });
    expect(
      (res.json() as { question: { generatedBy: string } }).question.generatedBy,
    ).not.toBe("fixed_template");
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

  it("POST /answers remains authenticated and rejects a malformed optional key", async () => {
    const { app } = await setup();
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/intakes/intake-id/answers",
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);

    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const q = await nextQuestion(app, intakeId, rev);
    const invalidKey = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: { ...authHeader(UID), ...idem("invalid key") },
      payload: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        answerState: "answered",
        expectedIntakeRevision: q.revision,
      },
    });
    expect(invalidKey.statusCode).toBe(400);
  });

  it("POST /answers replays an answer when a valid optional key is supplied", async () => {
    const { app } = await setup();
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const q = await nextQuestion(app, intakeId, rev);
    const request = {
      method: "POST" as const,
      url: `/v1/intakes/${intakeId}/answers`,
      headers: { ...authHeader(UID), ...idem("answer-route-replay-key") },
      payload: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        answerState: "answered" as const,
        expectedIntakeRevision: q.revision,
      },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
  });

  it("OpenAPI declares POST /answers Idempotency-Key as optional", async () => {
    const { app } = await setup();
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    expect(response.statusCode).toBe(200);
    const spec = response.json() as {
      paths: Record<string, { post?: { parameters?: Array<{ name: string; in: string; required?: boolean }> } }>;
    };
    const params = spec.paths["/v1/intakes/{intakeId}/answers"]?.post?.parameters ?? [];
    expect(params.find(({ name }) => name === "idempotency-key")).toMatchObject({
      in: "header",
      required: false,
    });
    await app.close();
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

  it("POST /finalize は登録デバイスへ一般文言で通知する（PHI非含有）", async () => {
    const { deps, app } = await setup();
    // デバイス登録（service層直接seedでもよいが経路確認のためAPI経由）
    const dev = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), ...idem("dev-1") },
      payload: { token: "tok-finalize-1", platform: "web" },
    });
    expect(dev.statusCode).toBe(201);

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
      headers: { ...authHeader(UID), ...idem("fin-notify") },
      payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
    });
    expect(fin.statusCode).toBe(200);
    const qid = (fin.json() as { questionnaireId: string }).questionnaireId;

    expect(deps.fakePush.calls).toHaveLength(1);
    const call = deps.fakePush.calls[0]!;
    expect(call.token).toBe("tok-finalize-1");
    // 症状「3日前から頭痛」等のPHIがタイトル・本文・dataに入らない
    expect(call.title).not.toContain("頭痛");
    expect(call.body).not.toContain("頭痛");
    expect(JSON.stringify(call.data ?? {})).not.toContain("頭痛");
    expect(call.data).toEqual({
      type: "QUESTIONNAIRE_READY",
      refId: qid,
    });
  });

  it("finalize の冪等リプレイは通知を再送しない", async () => {
    const { deps, app } = await setup();
    await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), ...idem("dev-2") },
      payload: { token: "tok-finalize-2", platform: "web" },
    });
    const { intakeId } = await createIntake(app);
    const rev = await toQuestioning(app, intakeId);
    const sum = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/summary`,
      headers: authHeader(UID),
      payload: { expectedIntakeRevision: rev },
    });
    const srev = (sum.json() as { intakeRevision: number }).intakeRevision;
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/intakes/${intakeId}/finalize`,
        headers: { ...authHeader(UID), ...idem("fin-notify-replay") },
        payload: {
          expectedIntakeRevision: srev,
          summaryReviewConfirmed: true,
        },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(deps.fakePush.calls).toHaveLength(1);
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
