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

describe("POST /answers idempotency / Firestore emulator", () => {
  let deps: EmulatorDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    await clearEmulatorFirestore();
    deps = makeEmulatorDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
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
});
