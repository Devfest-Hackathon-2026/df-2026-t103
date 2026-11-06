import { describe, expect, it } from "vitest";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  appendQuestion,
  createIntake,
  getIntakeDetail,
  patchAnswer,
  saveAnswer,
  submitSymptoms,
  transitionIntake,
} from "../../src/services/intakes.js";
import type { ApiError } from "../../src/lib/errors.js";
import type {
  IntakeDoc,
  QuestionDoc,
} from "../../src/domain/firestoreDocs.js";

const UID = "patient-1";

async function makeIntake(deps: TestDeps): Promise<string> {
  const r = await createIntake(deps, {
    uid: UID,
    body: { locale: "ja-JP" },
    idempotencyKey: "idem-" + Math.random().toString(36).slice(2),
  });
  return r.intakeId;
}

async function makeQuestioning(deps: TestDeps): Promise<string> {
  const intakeId = await makeIntake(deps);
  await submitSymptoms(deps, {
    uid: UID,
    intakeId,
    body: {
      initialSymptomText: "3日前から頭痛がします",
      bodyLocations: ["head"],
      expectedIntakeRevision: 1,
    },
  });
  return intakeId;
}

describe("intake domain (#9)", () => {
  it("creates a draft intake at revision 1 with expiry", async () => {
    const deps = makeTestDeps();
    const { intakeId, status, revision } = await createIntake(deps, {
      uid: UID,
      body: { locale: "ja-JP" },
      idempotencyKey: "k1",
    });
    expect(status).toBe("draft");
    expect(revision).toBe(1);
    const doc = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    expect(doc?.patientUid).toBe(UID);
    expect(doc?.status).toBe("draft");
    expect(doc?.questionCount).toBe(0);
    expect(doc?.expiresAt).toBeDefined();
  });

  it("replays createIntake with same idempotency key", async () => {
    const deps = makeTestDeps();
    const a = await createIntake(deps, {
      uid: UID,
      body: { locale: "ja-JP" },
      idempotencyKey: "same-key",
    });
    const b = await createIntake(deps, {
      uid: UID,
      body: { locale: "ja-JP" },
      idempotencyKey: "same-key",
    });
    expect(b.intakeId).toBe(a.intakeId);
  });

  it("rejects different body under same idempotency key", async () => {
    const deps = makeTestDeps();
    await createIntake(deps, {
      uid: UID,
      body: { locale: "ja-JP" },
      idempotencyKey: "dup-key",
    });
    await expect(
      createIntake(deps, {
        uid: UID,
        body: { locale: "en-US" },
        idempotencyKey: "dup-key",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("submits symptoms → questioning, revision increments", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeIntake(deps);
    const r = await submitSymptoms(deps, {
      uid: UID,
      intakeId,
      body: {
        initialSymptomText: "  昨日から熱っぽい  ",
        bodyLocations: ["whole_body"],
        expectedIntakeRevision: 1,
      },
    });
    expect(r.status).toBe("questioning");
    expect(r.revision).toBe(2);
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    expect(detail.initialSymptomText).toBe("昨日から熱っぽい");
    expect(detail.bodyLocations).toEqual(["whole_body"]);
  });

  it("detects red-flag terms in symptoms (safetyFlags)", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeIntake(deps);
    await submitSymptoms(deps, {
      uid: UID,
      intakeId,
      body: {
        initialSymptomText: "胸が痛い、動けない",
        bodyLocations: ["chest"],
        expectedIntakeRevision: 1,
      },
    });
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    expect(detail.safetyFlags.length).toBeGreaterThan(0);
  });

  it("rejects invalid symptom text (FR-I01)", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeIntake(deps);
    await expect(
      submitSymptoms(deps, {
        uid: UID,
        intakeId,
        body: {
          initialSymptomText: "   ",
          bodyLocations: [],
          expectedIntakeRevision: 1,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      submitSymptoms(deps, {
        uid: UID,
        intakeId,
        body: {
          initialSymptomText: "！！！？？？",
          bodyLocations: [],
          expectedIntakeRevision: 1,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      submitSymptoms(deps, {
        uid: UID,
        intakeId,
        body: {
          initialSymptomText: "あ".repeat(1001),
          bodyLocations: [],
          expectedIntakeRevision: 1,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects stale expectedIntakeRevision (optimistic lock)", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    await expect(
      submitSymptoms(deps, {
        uid: UID,
        intakeId,
        body: {
          initialSymptomText: "症状が変わった",
          bodyLocations: [],
          expectedIntakeRevision: 99,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "REVISION_CONFLICT" });
  });

  it("hides other patients' intakes (404)", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeIntake(deps);
    await expect(
      getIntakeDetail(deps, { uid: "other-user", intakeId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      submitSymptoms(deps, {
        uid: "other-user",
        intakeId,
        body: {
          initialSymptomText: "悪用",
          bodyLocations: [],
          expectedIntakeRevision: 1,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("appends questions, enforces max count, tracks currentQuestionId", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    let rev = 2;
    const { questionId, intakeRevision } = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: rev,
      question: {
        questionText: "いつ頃からですか？",
        topic: "onset_timing",
        options: [{ code: "A", label: "今日" }],
        generatedBy: "fixed_template",
      },
    });
    rev = intakeRevision;
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    expect(detail.questionCount).toBe(1);
    expect(detail.currentQuestionId).toBe(questionId);
    expect(detail.questions[0]?.data.status).toBe("active");

    // fill up to the cap
    while (true) {
      try {
        const r = await appendQuestion(deps, {
          uid: UID,
          intakeId,
          expectedIntakeRevision: rev,
          question: {
            questionText: `質問${rev}`,
            topic: `t${rev}`,
            options: [],
            generatedBy: "fallback",
          },
        });
        rev = r.intakeRevision;
      } catch (e) {
        expect((e as ApiError).statusCode).toBe(412);
        break;
      }
    }
    const final = await getIntakeDetail(deps, { uid: UID, intakeId });
    expect(final.questionCount).toBe(12);
  });

  it("saves an answer and preserves freeText + questionRevision (FR-I05)", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "期間は？",
        topic: "onset",
        options: [
          { code: "LT_WEEK", label: "1週間以内" },
          { code: "GT_MONTH", label: "1か月以上" },
        ],
        generatedBy: "llm",
        modelVersion: "approved-v1",
      },
    });
    const r = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["LT_WEEK"],
        freeText: "昨日の夜から",
        answerState: "answered",
        expectedIntakeRevision: q.intakeRevision,
      },
    });
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    expect(detail.revision).toBe(r.intakeRevision);
    const ans = detail.answers.find((a) => a.answerId === q.questionId);
    expect(ans?.data.freeText).toBe("昨日の夜から");
    expect(ans?.data.selectedCodes).toEqual(["LT_WEEK"]);
    expect(ans?.data.questionRevision).toBe(1);
    const question = detail.questions.find(
      (x) => x.questionId === q.questionId,
    );
    expect(question?.data.status).toBe("answered");
  });

  it("rejects answer codes not in the question options", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "期間は？",
        topic: "onset",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    await expect(
      saveAnswer(deps, {
        uid: UID,
        intakeId,
        body: {
          questionId: q.questionId,
          questionRevision: 1,
          selectedCodes: ["NOT_AN_OPTION"],
          answerState: "answered",
          expectedIntakeRevision: q.intakeRevision,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects answers on nonexistent or invalidated questions", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    await expect(
      saveAnswer(deps, {
        uid: UID,
        intakeId,
        body: {
          questionId: "nope",
          questionRevision: 1,
          selectedCodes: [],
          answerState: "answered",
          expectedIntakeRevision: 2,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("patchAnswer invalidates later active questions", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q1 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "q1",
        topic: "t1",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    const q2 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: q1.intakeRevision,
      question: {
        questionText: "q2",
        topic: "t2",
        options: [],
        generatedBy: "llm",
      },
    });
    const a1 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        answerState: "answered",
        expectedIntakeRevision: q2.intakeRevision,
      },
    });
    await patchAnswer(deps, {
      uid: UID,
      intakeId,
      answerId: q1.questionId,
      body: {
        questionRevision: 1,
        selectedCodes: ["A"],
        freeText: "訂正",
        expectedIntakeRevision: a1.intakeRevision,
      },
    });
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    const q2doc = detail.questions.find(
      (x) => x.questionId === q2.questionId,
    );
    expect(q2doc?.data.status).toBe("invalidated");
  });

  it("回答済みの後続質問も無効化し、その回答を除去する", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q1 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "q1",
        topic: "t1",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    const q2 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: q1.intakeRevision,
      question: {
        questionText: "q2",
        topic: "t2",
        options: [{ code: "B", label: "b" }],
        generatedBy: "llm",
      },
    });
    const a1 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        answerState: "answered",
        expectedIntakeRevision: q2.intakeRevision,
      },
    });
    const a2 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q2.questionId,
        questionRevision: 1,
        selectedCodes: ["B"],
        answerState: "answered",
        expectedIntakeRevision: a1.intakeRevision,
      },
    });
    // 先の回答を編集 → 後続の回答済み質問(q2)も無効化され回答は除去される
    await patchAnswer(deps, {
      uid: UID,
      intakeId,
      answerId: q1.questionId,
      body: {
        questionRevision: 1,
        selectedCodes: ["A"],
        freeText: "訂正",
        expectedIntakeRevision: a2.intakeRevision,
      },
    });
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    const q2doc = detail.questions.find((x) => x.questionId === q2.questionId);
    expect(q2doc?.data.status).toBe("invalidated");
    // 旧分岐の回答は除去される（現在ブランチに残存しない）
    const a2doc = await deps.memDb
      .doc(`intakes/${intakeId}/answers/${q2.questionId}`)
      .get();
    expect(a2doc.exists).toBe(false);
  });

  it("saveAnswer で既回答を置換した場合も後続分岐を再評価する", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q1 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "q1",
        topic: "t1",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    const q2 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: q1.intakeRevision,
      question: {
        questionText: "q2",
        topic: "t2",
        options: [{ code: "B", label: "b" }],
        generatedBy: "llm",
      },
    });
    const a1 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        answerState: "answered",
        expectedIntakeRevision: q2.intakeRevision,
      },
    });
    const a2 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q2.questionId,
        questionRevision: 1,
        selectedCodes: ["B"],
        answerState: "answered",
        expectedIntakeRevision: a1.intakeRevision,
      },
    });
    // POST /answers で既回答の q1 を再度送信（PATCH と同等の置換）
    await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        answerState: "answered",
        expectedIntakeRevision: a2.intakeRevision,
      },
    });
    const q2doc = (
      await deps.memDb
        .doc(`intakes/${intakeId}/questions/${q2.questionId}`)
        .get()
    ).data() as QuestionDoc | undefined;
    expect(q2doc?.status).toBe("invalidated");
    const a2doc = await deps.memDb
      .doc(`intakes/${intakeId}/answers/${q2.questionId}`)
      .get();
    expect(a2doc.exists).toBe(false);
  });

  it("review 中の編集で質問が無効化されたら questioning へ戻す", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q1 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "q1",
        topic: "t1",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fixed_template",
      },
    });
    const q2 = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: q1.intakeRevision,
      question: {
        questionText: "q2",
        topic: "t2",
        options: [],
        generatedBy: "llm",
      },
    });
    const a1 = await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q1.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        answerState: "answered",
        expectedIntakeRevision: q2.intakeRevision,
      },
    });
    // review へ遷移させてから先の回答を編集する
    await deps.memDb.doc(`intakes/${intakeId}`).update({ status: "review" });
    await patchAnswer(deps, {
      uid: UID,
      intakeId,
      answerId: q1.questionId,
      body: {
        questionRevision: 1,
        selectedCodes: ["A"],
        freeText: "訂正",
        expectedIntakeRevision: a1.intakeRevision,
      },
    });
    const doc = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    expect(doc?.status).toBe("questioning");
  });

  it("resume: answers persist across getIntakeDetail reads (FR-I06)", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const q = await appendQuestion(deps, {
      uid: UID,
      intakeId,
      expectedIntakeRevision: 2,
      question: {
        questionText: "期間は？",
        topic: "onset",
        options: [{ code: "A", label: "a" }],
        generatedBy: "fallback",
      },
    });
    await saveAnswer(deps, {
      uid: UID,
      intakeId,
      body: {
        questionId: q.questionId,
        questionRevision: 1,
        selectedCodes: ["A"],
        answerState: "answered",
        expectedIntakeRevision: q.intakeRevision,
      },
    });
    // 中断→別の呼び出しで再読込
    const detail = await getIntakeDetail(deps, { uid: UID, intakeId });
    expect(detail.status).toBe("questioning");
    expect(detail.answers).toHaveLength(1);
    expect(detail.questions).toHaveLength(1);
  });

  it("archives expired drafts and rejects further writes (FR-I06 TTL)", async () => {
    const deps = makeTestDeps({ intakeDraftTtlDays: 1 });
    const intakeId = await makeIntake(deps);
    deps.clock.advanceMs(25 * 3600_000); // > 1 day
    await expect(
      submitSymptoms(deps, {
        uid: UID,
        intakeId,
        body: {
          initialSymptomText: "頭痛",
          bodyLocations: ["head"],
          expectedIntakeRevision: 1,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 412 });
    const doc = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    expect(doc?.status).toBe("archived");
  });

  it("transitionIntake: questioning → review → finalized; invalid transitions rejected", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeQuestioning(deps);
    const toReview = await transitionIntake(deps, {
      uid: UID,
      intakeId,
      to: "review",
      expectedIntakeRevision: 2,
    });
    expect(toReview.status).toBe("review");
    // review → questioning（戻る）は許可
    const back = await transitionIntake(deps, {
      uid: UID,
      intakeId,
      to: "questioning",
      expectedIntakeRevision: toReview.revision,
    });
    const toReview2 = await transitionIntake(deps, {
      uid: UID,
      intakeId,
      to: "review",
      expectedIntakeRevision: back.revision,
    });
    const fin = await transitionIntake(deps, {
      uid: UID,
      intakeId,
      to: "finalized",
      expectedIntakeRevision: toReview2.revision,
    });
    expect(fin.status).toBe("finalized");
    const doc = (await deps.memDb.doc(`intakes/${intakeId}`).get()).data() as
      | IntakeDoc
      | undefined;
    expect(doc?.finalizedAt).toBeDefined();
    // finalized からの遷移は不可
    await expect(
      transitionIntake(deps, {
        uid: UID,
        intakeId,
        to: "questioning",
        expectedIntakeRevision: fin.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 412 });
    // draft → finalized は直接不可
    const d2 = await makeIntake(deps);
    await expect(
      transitionIntake(deps, {
        uid: UID,
        intakeId: d2,
        to: "finalized",
        expectedIntakeRevision: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  it("appendQuestion requires questioning status", async () => {
    const deps = makeTestDeps();
    const intakeId = await makeIntake(deps); // still draft
    await expect(
      appendQuestion(deps, {
        uid: UID,
        intakeId,
        expectedIntakeRevision: 1,
        question: {
          questionText: "q",
          topic: "t",
          options: [],
          generatedBy: "fixed_template",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 412 });
  });
});
