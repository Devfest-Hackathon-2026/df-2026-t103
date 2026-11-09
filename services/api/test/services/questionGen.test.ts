import { describe, expect, it } from "vitest";
import { makeTestConfig, makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { generateNextQuestion } from "../../src/services/questionGen.js";
import {
  createIntake,
  submitSymptoms,
  appendQuestion,
  saveAnswer,
  patchAnswer,
} from "../../src/services/intakes.js";
import {
  checkForbiddenOutput,
  llmOutputSchema,
  normalizeAnswers,
} from "../../src/ai/questionSchema.js";
import type { IntakeDoc } from "../../src/domain/firestoreDocs.js";

const UID = "patient-1";

async function intakeAt(
  deps: TestDeps,
): Promise<{ intakeId: string; doc: IntakeDoc }> {
  const { intakeId } = await createIntake(deps, {
    uid: UID,
    body: { locale: "ja-JP" },
    idempotencyKey: "k-" + Math.random().toString(36).slice(2),
  });
  await submitSymptoms(deps, {
    uid: UID,
    intakeId,
    body: {
      initialSymptomText: "頭痛がします",
      bodyLocations: ["head"],
      expectedIntakeRevision: 1,
    },
  });
  const doc = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
    | IntakeDoc
    | undefined;
  if (doc === undefined) throw new Error("intake missing");
  return { intakeId, doc };
}

describe("questionGen (#10)", () => {
  it("AI未承認時は固定質問を fixed_template として返す（FR-I10）", async () => {
    const deps = makeTestDeps();
    const { intakeId, doc } = await intakeAt(deps);
    const q = await generateNextQuestion(deps, { intakeId, intake: doc });
    expect(q?.generatedBy).toBe("fixed_template");
    expect(q?.topic).toBe("onset_timing");
    expect(q?.options.some((o) => o.code === "UNKNOWN")).toBe(true);
    expect(deps.fakeLlm.calls).toHaveLength(0);
  });

  it("全体設定が無効なら既存のAI承認問診もLLMを呼ばずfallbackする", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: false });
    const { intakeId, doc } = await intakeAt(deps);
    const q = await generateNextQuestion(deps, {
      intakeId,
      intake: { ...doc, aiEnabledForThisIntake: true },
    });
    expect(q?.generatedBy).toBe("fallback");
    expect(q?.topic).toBe("onset_timing");
    expect(deps.fakeLlm.calls).toHaveLength(0);
  });

  it("全体AI有効でも問診単位で未承認ならLLMを呼ばない", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId, doc } = await intakeAt(deps);
    await deps.memDb.doc(`intakes/${intakeId}`).update({
      aiEnabledForThisIntake: false,
    });

    const q = await generateNextQuestion(deps, {
      intakeId,
      intake: { ...doc, aiEnabledForThisIntake: false },
    });

    expect(q?.generatedBy).toBe("fixed_template");
    expect(deps.fakeLlm.calls).toHaveLength(0);
  });

  it("新規問診の承認を保持し、停止中はfallback・再有効化後はLLMを使う", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId, doc } = await intakeAt(deps);
    expect(doc.aiEnabledForThisIntake).toBe(true);

    deps.config = makeTestConfig({ aiIntakeEnabled: false });
    const stopped = await generateNextQuestion(deps, { intakeId, intake: doc });
    expect(stopped?.generatedBy).toBe("fallback");
    expect(deps.fakeLlm.calls).toHaveLength(0);
    expect(
      (await deps.memDb.doc(`intakes/${intakeId}`).get()).data()
        ?.aiEnabledForThisIntake,
    ).toBe(true);

    deps.config = makeTestConfig({ aiIntakeEnabled: true });
    deps.fakeLlm.result = {
      questions: [
        {
          questionText: "痛みの性質を教えてください",
          topic: "pain_quality",
          options: [
            { code: "YES", label: "はい" },
            { code: "NO", label: "いいえ" },
          ],
        },
      ],
      modelVersion: "fake-v1",
    };
    const resumed = await generateNextQuestion(deps, { intakeId, intake: doc });
    expect(resumed?.generatedBy).toBe("llm");
    expect(deps.fakeLlm.calls).toHaveLength(1);
    expect(
      (await deps.memDb.doc(`intakes/${intakeId}`).get()).data()
        ?.aiEnabledForThisIntake,
    ).toBe(true);
  });

  it("AI承認済みは LLM 経路を使い generatedBy=llm", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId, doc } = await intakeAt(deps);
    deps.fakeLlm.result = {
      questions: [
        {
          questionText: "痛みはズキズキしますか？",
          topic: "pain_quality",
          options: [
            { code: "YES", label: "はい" },
            { code: "NO", label: "いいえ" },
          ],
        },
      ],
      modelVersion: "fake-v1",
    };
    const q = await generateNextQuestion(deps, { intakeId, intake: doc });
    expect(q?.generatedBy).toBe("llm");
    expect(q?.topic).toBe("pain_quality");
    expect(q?.modelVersion).toBe("fake-v1");
    // UNKNOWN はサービス側で補完される
    expect(q?.options.at(-1)?.code).toBe("UNKNOWN");
    expect(deps.fakeLlm.calls).toHaveLength(1);
  });

  it("LLM入力には正規化された回答JSONと既出トピックが渡る", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId } = await intakeAt(deps);
    const a = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "期間は？",
        topic: "onset_timing",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    const s = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: a.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        freeText: "昨日から",
        answerState: "answered",
        expectedIntakeRevision: a.intakeRevision,
      },
    });
    void s;
    const doc2 = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    await generateNextQuestion(deps, {
      intakeId,
      intake: doc2 as IntakeDoc,
    });
    const input = deps.fakeLlm.calls[0];
    expect(input?.askedTopics).toContain("onset_timing");
    expect(input?.remainingTopics).not.toContain("onset_timing");
    expect(input?.answers).toHaveLength(1);
    expect(input?.answers[0]?.freeText).toBe("昨日から");
    expect(input?.answers[0]?.topic).toBe("onset_timing");
  });

  it("回答の質問文・選択ラベルをLLM入力へ含める（コードのみでは解釈不能）", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId, doc } = await intakeAt(deps);
    const q1 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: doc.revision,
      question: {
        questionText: "いつから痛みますか？",
        topic: "onset_timing",
        options: [
          { code: "LT_WEEK", label: "1週間未満" },
          { code: "GT_WEEK", label: "1週間以上" },
        ],
        generatedBy: "fixed_template",
      },
    });
    await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["GT_WEEK"],
        answerState: "answered",
        expectedIntakeRevision: q1.intakeRevision,
      },
    });
    const doc2 = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    await generateNextQuestion(deps, {
      intakeId,
      intake: doc2 as IntakeDoc,
    });
    const input = deps.fakeLlm.calls[0];
    const ans = input?.answers[0];
    expect(ans?.questionText).toBe("いつから痛みますか？");
    expect(ans?.selectedCodes).toEqual(["GT_WEEK"]);
    expect(ans?.selectedLabels).toEqual(["1週間以上"]);
  });

  it("無効化された質問のトピックは再出題できる（重複判定から除外）", async () => {
    const deps = makeTestDeps();
    const { intakeId, doc } = await intakeAt(deps);
    const q1 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: doc.revision,
      question: {
        questionText: "いつから痛みますか？",
        topic: "onset_timing",
        options: [{ code: "LT_WEEK", label: "1週間未満" }],
        generatedBy: "fixed_template",
      },
    });
    const q2 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: q1.intakeRevision,
      question: {
        questionText: "痛みの強さは？",
        topic: "severity",
        options: [{ code: "MILD", label: "軽い" }],
        generatedBy: "llm",
      },
    });
    const a1 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        answerState: "answered",
        expectedIntakeRevision: q2.intakeRevision,
      },
    });
    // q1 の回答を編集 → q2 は invalidated になる
    const p = await patchAnswer(deps, {
      uid: UID,
      intakeId,
      answerId: q1.questionId,
      body: {
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        freeText: "訂正",
        expectedIntakeRevision: a1.intakeRevision,
      },
    });
    const q2doc = await deps.memDb
      .doc(`intakes/${intakeId}/questions/${q2.questionId}`)
      .get();
    expect((q2doc.data() as { status: string }).status).toBe("invalidated");
    void p;
    const doc3 = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    const next = await generateNextQuestion(deps, {
      intakeId,
      intake: doc3 as IntakeDoc,
    });
    // severity は無効化済みなので再出題可能（frequency へ進まない）
    expect(next?.topic).toBe("severity");
  });

  it("LLM障害時は固定質問へフォールバック（BR-03）", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId, doc } = await intakeAt(deps);
    deps.fakeLlm.shouldThrow = new Error("llm/down");
    const q = await generateNextQuestion(deps, { intakeId, intake: doc });
    expect(q?.generatedBy).toBe("fallback");
    expect(q?.topic).toBe("onset_timing");
  });

  it("禁則出力（病名診断・リスク%）は弾いて次候補/固定へ進む（FR-I09）", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId, doc } = await intakeAt(deps);
    deps.fakeLlm.result = {
      questions: [
        {
          questionText: "脳梗塞の可能性が80%あります",
          topic: "diagnosis_yes",
          options: [{ code: "YES", label: "はい" }],
        },
        {
          questionText: "安静にしていても痛みますか？",
          topic: "pain_at_rest",
          options: [
            { code: "YES", label: "はい" },
            { code: "NO", label: "いいえ" },
          ],
        },
      ],
      modelVersion: "fake-v1",
    };
    const q = await generateNextQuestion(deps, { intakeId, intake: doc });
    expect(q?.topic).toBe("pain_at_rest");
    expect(q?.generatedBy).toBe("llm");
  });

  it("既出トピックの LLM 質問はスキップする", async () => {
    const deps = makeTestDeps({ aiIntakeEnabled: true });
    const { intakeId } = await intakeAt(deps);
    await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "期間は？",
        topic: "onset_timing",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    const doc2 = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    deps.fakeLlm.result = {
      questions: [
        {
          questionText: "いつからですか？（重複）",
          topic: "onset_timing",
          options: [{ code: "A", label: "a" }],
        },
      ],
      modelVersion: "fake-v1",
    };
    const q = await generateNextQuestion(deps, {
      intakeId,
      intake: doc2 as IntakeDoc,
    });
    // 重複トピックは採用せず固定の次トピックへ
    expect(q?.topic).toBe("severity");
    expect(q?.generatedBy).toBe("fallback");
  });

  it("全トピック出題済みなら null", async () => {
    const deps = makeTestDeps();
    const { intakeId } = await intakeAt(deps);
    let rev = 2;
    for (const topic of [
      "onset_timing",
      "severity",
      "frequency",
      "life_impact",
      "associated_symptoms",
      "current_medication",
      "medical_history",
      "allergy",
    ]) {
      const r = await appendQuestion(deps, {
        uid: UID,
        intakeId,
        expectedIntakeRevision: rev,
        question: {
          questionText: `q-${topic}`,
          topic,
          options: [{ code: "A", label: "a" }],
          generatedBy: "fixed_template",
        },
      });
      rev = r.intakeRevision;
    }
    const doc2 = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    const q = await generateNextQuestion(deps, {
      intakeId,
      intake: doc2 as IntakeDoc,
    });
    expect(q).toBeNull();
  });
});

describe("forbidden output filter (#10)", () => {
  const base = {
    topic: "t",
    options: [{ code: "A", label: "a" }],
  };
  const cases: Array<[string, boolean]> = [
    ["症状はいつからですか？", true],
    ["痛みの程度を教えてください", true],
    ["脳梗塞の診断がつきます", false],
    ["リスクは30%です", false],
    ["薬を中止してください", false],
    ["受診は不要です", false],
    ["今すぐ病院へ行ってください", false],
    ["癌の可能性があります", false],
    ["肺炎の疑いがあります", false],
  ];
  for (const [text, expected] of cases) {
    it(`"${text.slice(0, 18)}…" → ${expected}`, () => {
      const r = checkForbiddenOutput({ ...base, questionText: text });
      expect(r.ok).toBe(expected);
    });
  }
  it("選択肢ラベル内の禁則も検出する", () => {
    const r = checkForbiddenOutput({
      ...base,
      questionText: "どうしますか？",
      options: [{ code: "A", label: "薬をやめる" }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("prescription_advice");
  });
});

describe("llmOutputSchema (#10)", () => {
  it("正しい出力を受理する", () => {
    const r = llmOutputSchema.safeParse({
      questions: [
        {
          questionText: "症状はいつから？",
          topic: "onset",
          options: [{ code: "A", label: "a" }, { code: "B", label: "b" }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });
  it("不正な出力を拒否する", () => {
    expect(
      llmOutputSchema.safeParse({ questions: [] }).success,
    ).toBe(false);
    expect(
      llmOutputSchema.safeParse({
        questions: [
          {
            questionText: "短",
            topic: "x",
            options: [{ code: "a", label: "x" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      llmOutputSchema.safeParse({
        questions: [
          {
            questionText: "質問文は十分な長さ",
            topic: "BAD-TOPIC",
            options: [
              { code: "A", label: "a" },
              { code: "B", label: "b" },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    // 選択肢コード重複は拒否（回答はコードのみ保存され解釈が壊れる。VAL-006）
    expect(
      llmOutputSchema.safeParse({
        questions: [
          {
            questionText: "質問文は十分な長さ",
            topic: "valid_topic",
            options: [
              { code: "A", label: "はい" },
              { code: "A", label: "いいえ" },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("normalizeAnswers (#10)", () => {
  it("回答を構造化JSONへ正規化する", () => {
    const out = normalizeAnswers([
      {
        questionId: "q1",
        topic: "onset",
        stepIndex: 0,
        selectedCodes: ["A"],
        freeText: "昨日から",
        answerState: "answered",
      },
      {
        questionId: "q2",
        topic: "severity",
        stepIndex: 1,
        selectedCodes: [],
        freeText: null,
        answerState: "skipped",
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.freeText).toBe("昨日から");
    expect(out[1]?.freeText).toBeNull();
    expect(out[1]?.answerState).toBe("skipped");
  });
});
