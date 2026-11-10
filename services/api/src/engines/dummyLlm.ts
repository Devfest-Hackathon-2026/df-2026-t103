import type {
  LlmAdapter,
  QuestionGenInput,
  QuestionGenOutput,
} from "../deps.js";
import { FIXED_QUESTIONS, UNKNOWN_OPTION } from "./fixedQuestions.js";

/**
 * 開発・試験用の決定的LLMスタブ。
 * 固定セットから次トピックの質問を "llm" 由来として返す。
 */
export class DummyLlmAdapter implements LlmAdapter {
  readonly name = "dummy";
  readonly modelVersion = "dummy-2026-11-01";

  generateQuestions(input: QuestionGenInput): Promise<QuestionGenOutput> {
    const asked = new Set(input.askedTopics);
    const next = FIXED_QUESTIONS.find((q) => !asked.has(q.topic));
    return Promise.resolve({
      questions: next !== undefined ? [{ ...next, options: [...next.options] }] : [],
      modelVersion: this.modelVersion,
    });
  }
}

/** UNKNOWN 選択肢を末尾に補完（既にあれば何もしない）。 */
export function withUnknownOption(
  options: Array<{ code: string; label: string }>,
): Array<{ code: string; label: string }> {
  if (options.some((o) => o.code === UNKNOWN_OPTION.code)) return options;
  if (options.length >= 4) return options;
  return [...options, { ...UNKNOWN_OPTION }];
}
