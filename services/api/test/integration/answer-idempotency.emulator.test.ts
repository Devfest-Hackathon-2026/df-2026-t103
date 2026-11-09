import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import {
  clearEmulatorFirestore,
  makeEmulatorDeps,
  type EmulatorDeps,
} from "../helpers/emulator.js";

const PATIENT = "emu-answer-idempotency-patient";
const OTHER_PATIENT = "emu-answer-idempotency-other-patient";

describe("POST /answers idempotency / Firestore emulator", () => {
  let deps: EmulatorDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    await clearEmulatorFirestore();
    deps = makeEmulatorDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedAccount(deps, OTHER_PATIENT);
    await seedCurrentConsents(deps, OTHER_PATIENT);
    app = buildTestApp(deps);
  });

  afterEach(async () => {
    await app.close();
    await clearEmulatorFirestore();
  });

  it("deduplicates concurrent identical posts, conflicts on changed body, and replays after a lost response", async () => {
    const intake = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      headers: {
        ...authHeader(PATIENT),
        "idempotency-key": "answer-idempotency-intake-key",
      },
      payload: { locale: "ja-JP" },
    });
    expect(intake.statusCode).toBe(201);
    const { intakeId } = intake.json() as { intakeId: string };

    const symptoms = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/symptoms`,
      headers: authHeader(PATIENT),
      payload: {
        initialSymptomText: "合成症状：数日前から頭痛",
        bodyLocations: ["head"],
        expectedIntakeRevision: 1,
      },
    });
    expect(symptoms.statusCode).toBe(200);

    const next = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/next-question`,
      headers: authHeader(PATIENT),
      payload: { expectedIntakeRevision: 2 },
    });
    expect(next.statusCode).toBe(200);
    const { question } = next.json() as {
      question: { questionId: string; options: { code: string }[] };
    };
    const selectedCode = question.options[0]?.code;
    expect(selectedCode).toBeTruthy();

    const payload = {
      questionId: question.questionId,
      questionRevision: 1,
      selectedCodes: [selectedCode!],
      freeText: "合成回答",
      answerState: "answered",
      expectedIntakeRevision: 3,
    };
    const headers = {
      ...authHeader(PATIENT),
      "idempotency-key": "answer-idempotency-replay-key",
    };
    const postAnswer = () =>
      app.inject({
        method: "POST",
        url: `/v1/intakes/${intakeId}/answers`,
        headers,
        payload,
      });

    // 同時到着する同一要求は両方成功し、同一の確定結果を返す。
    const [first, concurrentReplay] = await Promise.all([
      postAnswer(),
      postAnswer(),
    ]);
    expect(first.statusCode).toBe(200);
    expect(concurrentReplay.statusCode).toBe(200);
    expect(concurrentReplay.json()).toEqual(first.json());
    const result = first.json() as { answerId: string; intakeRevision: number };
    expect(result.answerId).toBe(question.questionId);
    expect(result.intakeRevision).toBe(4);

    // 同じキーを別本文に再利用すると衝突し、保存済み回答を変更しない。
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers,
      payload: { ...payload, freeText: "異なる合成回答" },
    });
    expect(conflict.statusCode).toBe(409);

    // 最初の commit 後に応答が失われた状況を、応答を利用せず同一要求を再送して再現。
    const recovered = await postAnswer();
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual(first.json());

    const answers = await deps.firestore
      .collection(`intakes/${intakeId}/answers`)
      .get();
    expect(answers.size).toBe(1);
    expect(answers.docs[0]!.data().freeText).toBe("合成回答");
    const storedIntake = await deps.firestore.doc(`intakes/${intakeId}`).get();
    expect(storedIntake.data()?.revision).toBe(4);
  });

  it("rejects unauthenticated and cross-owner access, and does not apply another intake's question", async () => {
    const createIntake = async (uid: string, key: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/intakes",
        headers: { ...authHeader(uid), "idempotency-key": key },
        payload: { locale: "ja-JP" },
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { intakeId: string }).intakeId;
    };
    const prepareQuestion = async (uid: string, intakeId: string) => {
      const symptoms = await app.inject({
        method: "POST",
        url: `/v1/intakes/${intakeId}/symptoms`,
        headers: authHeader(uid),
        payload: {
          initialSymptomText: "合成症状：数日前から頭痛",
          bodyLocations: ["head"],
          expectedIntakeRevision: 1,
        },
      });
      expect(symptoms.statusCode).toBe(200);
      const next = await app.inject({
        method: "POST",
        url: `/v1/intakes/${intakeId}/next-question`,
        headers: authHeader(uid),
        payload: { expectedIntakeRevision: 2 },
      });
      expect(next.statusCode).toBe(200);
      return (
        next.json() as {
          question: { questionId: string; options: { code: string }[] };
        }
      ).question;
    };

    const ownerIntakeId = await createIntake(PATIENT, "owner-intake-key");
    const otherIntakeId = await createIntake(PATIENT, "other-intake-key");
    const foreignOwnerIntakeId = await createIntake(
      OTHER_PATIENT,
      "foreign-owner-intake-key",
    );
    const ownerQuestion = await prepareQuestion(PATIENT, ownerIntakeId);
    await prepareQuestion(PATIENT, otherIntakeId);
    const foreignOwnerQuestion = await prepareQuestion(
      OTHER_PATIENT,
      foreignOwnerIntakeId,
    );
    const sharedAnswerKey = "answer-key-shared-across-owners";

    const answerPayload = {
      questionId: ownerQuestion.questionId,
      questionRevision: 1,
      selectedCodes: [ownerQuestion.options[0]!.code],
      freeText: "所有者の合成回答",
      answerState: "answered",
      expectedIntakeRevision: 3,
    };
    const saved = await app.inject({
      method: "POST",
      url: `/v1/intakes/${ownerIntakeId}/answers`,
      headers: {
        ...authHeader(PATIENT),
        "idempotency-key": sharedAnswerKey,
      },
      payload: answerPayload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      answerId: ownerQuestion.questionId,
      intakeRevision: 4,
    });

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/v1/intakes/${ownerIntakeId}`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const foreignRead = await app.inject({
      method: "GET",
      url: `/v1/intakes/${ownerIntakeId}`,
      headers: authHeader(OTHER_PATIENT),
    });
    expect(foreignRead.statusCode).toBe(404);
    const foreignWrite = await app.inject({
      method: "POST",
      url: `/v1/intakes/${ownerIntakeId}/answers`,
      headers: {
        ...authHeader(OTHER_PATIENT),
        "idempotency-key": sharedAnswerKey,
      },
      payload: answerPayload,
    });
    expect(foreignWrite.statusCode).toBe(404);
    expect(JSON.stringify(foreignWrite.json())).not.toContain("所有者の合成回答");

    // 同じキーでも UID が異なる要求は別スコープで処理される。
    const otherOwnerSaved = await app.inject({
      method: "POST",
      url: `/v1/intakes/${foreignOwnerIntakeId}/answers`,
      headers: {
        ...authHeader(OTHER_PATIENT),
        "idempotency-key": sharedAnswerKey,
      },
      payload: {
        questionId: foreignOwnerQuestion.questionId,
        questionRevision: 1,
        selectedCodes: [foreignOwnerQuestion.options[0]!.code],
        freeText: "別所有者の合成回答",
        answerState: "answered",
        expectedIntakeRevision: 3,
      },
    });
    expect(otherOwnerSaved.statusCode).toBe(200);
    expect(otherOwnerSaved.json()).toMatchObject({
      answerId: foreignOwnerQuestion.questionId,
      intakeRevision: 4,
    });

    // 同一 UID・同一キーを別 intake の別本文で使うと競合し、回答も revision も変わらない。
    const sameOwnerDifferentIntake = await app.inject({
      method: "POST",
      url: `/v1/intakes/${otherIntakeId}/answers`,
      headers: {
        ...authHeader(PATIENT),
        "idempotency-key": sharedAnswerKey,
      },
      payload: {
        questionId: ownerQuestion.questionId,
        questionRevision: 1,
        selectedCodes: [ownerQuestion.options[0]!.code],
        freeText: "別 intake の合成回答",
        answerState: "answered",
        expectedIntakeRevision: 3,
      },
    });
    expect(sameOwnerDifferentIntake.statusCode).toBe(409);

    const reusedQuestion = await app.inject({
      method: "POST",
      url: `/v1/intakes/${otherIntakeId}/answers`,
      headers: authHeader(PATIENT),
      payload: {
        ...answerPayload,
        questionId: ownerQuestion.questionId,
      },
    });
    expect(reusedQuestion.statusCode).toBe(404);

    const ownerSnapshot = await app.inject({
      method: "GET",
      url: `/v1/intakes/${ownerIntakeId}`,
      headers: authHeader(PATIENT),
    });
    expect(ownerSnapshot.statusCode).toBe(200);
    expect(ownerSnapshot.json().answers).toEqual([
      expect.objectContaining({
        answerId: ownerQuestion.questionId,
        freeText: "所有者の合成回答",
        selectedCodes: answerPayload.selectedCodes,
      }),
    ]);

    const ownerStoredAnswers = await deps.firestore
      .collection(`intakes/${ownerIntakeId}/answers`)
      .get();
    const otherStoredAnswers = await deps.firestore
      .collection(`intakes/${otherIntakeId}/answers`)
      .get();
    const foreignStoredAnswers = await deps.firestore
      .collection(`intakes/${foreignOwnerIntakeId}/answers`)
      .get();
    expect(ownerStoredAnswers.size).toBe(1);
    expect(ownerStoredAnswers.docs[0]!.data().freeText).toBe(
      "所有者の合成回答",
    );
    expect(otherStoredAnswers.size).toBe(0);
    expect(foreignStoredAnswers.size).toBe(1);
    expect(foreignStoredAnswers.docs[0]!.data().freeText).toBe(
      "別所有者の合成回答",
    );
    expect(
      (await deps.firestore.doc(`intakes/${ownerIntakeId}`).get()).data()
        ?.revision,
    ).toBe(4);
    expect(
      (await deps.firestore.doc(`intakes/${otherIntakeId}`).get()).data()
        ?.revision,
    ).toBe(3);
    expect(
      (await deps.firestore.doc(`intakes/${foreignOwnerIntakeId}`).get()).data()
        ?.revision,
    ).toBe(4);
    expect(ownerSnapshot.json().answers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ freeText: "別所有者の合成回答" }),
      ]),
    );
  });
});
