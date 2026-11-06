import type { Deps, QuestionGenInput } from "../deps.js";
import {
  checkForbiddenOutput,
  normalizeAnswers,
  type LlmQuestion,
} from "../ai/questionSchema.js";
import { INTAKE_MAX_QUESTIONS } from "../domain/intake.js";
import type { IntakeDoc } from "../domain/firestoreDocs.js";
import type { QuestionGeneratedBy } from "../domain/types.js";
import {
  FIXED_TOPICS,
  nextFixedQuestion,
} from "../engines/fixedQuestions.js";
import { withUnknownOption } from "../engines/dummyLlm.js";
import { listAnswers, listQuestions } from "../repos/intakes.js";

export interface NextQuestionSpec {
  questionText: string;
  topic: string;
  options: Array<{ code: string; label: string }>;
  generatedBy: QuestionGeneratedBy;
  modelVersion?: string;
}

function toSpec(
  q: LlmQuestion,
  generatedBy: QuestionGeneratedBy,
  modelVersion?: string,
): NextQuestionSpec {
  return {
    questionText: q.questionText,
    topic: q.topic,
    options: withUnknownOption(q.options),
    generatedBy,
    ...(modelVersion !== undefined ? { modelVersion } : {}),
  };
}

/**
 * 次質問を決める（FR-I03/I04/I10, BR-03）。
 * 1. AI承認済みなら LLM を試行（スキーマ+禁則+トピック重複を検査）
 * 2. 失敗・非承認時は固定質問に決定的にフォールバック
 * 3. 全トピック出題済み・質問数上限なら null（呼出側が review へ進める）
 */
export async function generateNextQuestion(
  deps: Deps,
  params: { intakeId: string; intake: IntakeDoc },
): Promise<NextQuestionSpec | null> {
  const { intakeId, intake } = params;
  const [questions, answers] = await Promise.all([
    listQuestions(deps.db, intakeId),
    listAnswers(deps.db, intakeId),
  ]);
  // 無効化済み質問は重複判定から外す（回答編集で無効化された分岐は再出題可能）
  const askedTopics = new Set(
    questions
      .filter((q) => q.data.status !== "invalidated")
      .map((q) => q.data.topic),
  );
  const remainingTopics = FIXED_TOPICS.filter((t) => !askedTopics.has(t));
  const budget = INTAKE_MAX_QUESTIONS - intake.questionCount;
  if (budget <= 0) return null;

  const qById = new Map(questions.map((q) => [q.id, q.data]));
  const answersNorm = normalizeAnswers(
    answers.map((a) => {
      // topic・質問文・選択ラベルは質問スナップショットから解決する
      // （コードだけではLLMが回答内容を解釈できない）
      const q = qById.get(a.data.questionId);
      return {
        questionId: a.data.questionId,
        topic: q?.topic ?? "",
        questionText: q?.questionText ?? "",
        stepIndex: a.data.stepIndex,
        selectedCodes: a.data.selectedCodes,
        selectedLabels: a.data.selectedCodes.map(
          (code) => q?.options.find((o) => o.code === code)?.label ?? code,
        ),
        freeText: a.data.freeText ?? null,
        answerState: a.data.answerState,
      };
    }),
  );

  // AI経路（本番承認フラグが立っている場合のみ）
  if (intake.aiEnabledForThisIntake) {
    const input: QuestionGenInput = {
      symptomText: intake.initialSymptomText ?? "",
      bodyLocations: intake.bodyLocations,
      locale: "ja-JP",
      answers: answersNorm,
      askedTopics: [...askedTopics],
      remainingTopics,
      maxQuestions: Math.min(budget, 3),
    };
    try {
      const out = await deps.llmAdapter.generateQuestions(input);
      for (const q of out.questions) {
        if (askedTopics.has(q.topic)) continue;
        const check = checkForbiddenOutput(q);
        if (!check.ok) {
          deps.logger.warn(
            { reason: check.reason, topic: q.topic },
            "llm question rejected by forbidden-output filter",
          );
          continue;
        }
        return toSpec(q, "llm", out.modelVersion);
      }
      deps.logger.warn(
        "llm returned no usable question; falling back to fixed set",
      );
    } catch (err) {
      // LLM障害・スキーマ不一致は固定質問で問診を継続できる（FR-I10）
      deps.logger.warn({ err }, "llm question generation failed; fallback");
    }
  }

  const fixed = nextFixedQuestion(askedTopics);
  if (fixed === null) return null;
  return toSpec(
    fixed,
    intake.aiEnabledForThisIntake ? "fallback" : "fixed_template",
  );
}
