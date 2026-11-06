import { z } from "zod";

/**
 * LLM出力の検証スキーマ（FR-I03, API契約層）。
 * Vertex AI の responseSchema と同形の JSON を期待する。
 */
export const llmOptionSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,29}$/u, "選択肢コードは大英字大文字+_ のみ"),
  label: z.string().trim().min(1).max(60),
});

export const llmQuestionSchema = z.object({
  questionText: z.string().trim().min(4).max(120),
  /** 収集トピック（snake_case）。重複検査に使う。 */
  topic: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),
  /** 原則3選択肢。「分からない」は呼出側で補完する。 */
  options: z.array(llmOptionSchema).min(2).max(4),
});

export const llmOutputSchema = z.object({
  questions: z.array(llmQuestionSchema).min(1).max(3),
});

export type LlmQuestion = z.infer<typeof llmQuestionSchema>;
export type LlmOutput = z.infer<typeof llmOutputSchema>;

/** Vertex AI generateContent の responseSchema（llmOutputSchema と同形）。 */
export const LLM_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          questionText: { type: "string", minLength: 4, maxLength: 120 },
          topic: {
            type: "string",
            pattern: "^[a-z][a-z0-9_]{0,39}$",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  pattern: "^[A-Z][A-Z0-9_]{0,29}$",
                },
                label: { type: "string", minLength: 1, maxLength: 60 },
              },
              required: ["code", "label"],
            },
          },
        },
        required: ["questionText", "topic", "options"],
      },
    },
  },
  required: ["questions"],
} as const;

/**
 * FR-I09 安全制御。AI出力に含めてはいけない内容の固定パターン。
 * 病名診断・リスク%・処方助言・受診不要判定・緊急判定は禁則。
 */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\d+(?:\.\d+)?\s*%/, reason: "risk_percent" },
  { re: /診断|確定診断|疾患|症候群|の疑い/, reason: "diagnosis" },
  {
    re: /可能性が(高い|あります|ありえる)|かもしれません/,
    reason: "diagnosis_suggestion",
  },
  {
    re: /(処方|投与|服用|服薬|薬)を(中止|変更|開始|追加|やめ|飲み|飲ん|止め|増や|減ら)/,
    reason: "prescription_advice",
  },
  {
    re: /受診(は不要|の必要はありません|しなくてよい|しなくて大丈夫)|様子を見て(大丈夫|よい)/,
    reason: "no_visit_judgment",
  },
  {
    re: /緊急(です|です。|事態)|救急車を(呼んで|呼ぶ)|今すぐ(受診|病院)/,
    reason: "emergency_judgment",
  },
];

export interface ForbiddenCheckResult {
  ok: boolean;
  reason?: string;
}

/** 質問文・選択肢ラベルに禁則文言が含まれないか検査する。 */
export function checkForbiddenOutput(q: LlmQuestion): ForbiddenCheckResult {
  const texts = [q.questionText, ...q.options.map((o) => o.label)];
  for (const text of texts) {
    for (const { re, reason } of FORBIDDEN_PATTERNS) {
      if (re.test(text)) return { ok: false, reason };
    }
  }
  return { ok: true };
}

/** AI入力用の正規化回答（構造化JSON。推測で埋めない）。 */
export interface NormalizedAnswer {
  questionId: string;
  topic: string;
  stepIndex: number;
  selectedCodes: string[];
  freeText: string | null;
  answerState: "answered" | "unknown" | "skipped";
}

/**
 * 回答を問診AIへ渡すJSONに正規化する。
 * 患者原文は保持し、LLM入力としてもそのまま使う。
 */
export function normalizeAnswers(
  answers: Array<{
    questionId: string;
    topic: string;
    stepIndex: number;
    selectedCodes: string[];
    freeText: string | null | undefined;
    answerState: "answered" | "unknown" | "skipped";
  }>,
): NormalizedAnswer[] {
  return answers.map((a) => ({
    questionId: a.questionId,
    topic: a.topic,
    stepIndex: a.stepIndex,
    selectedCodes: a.selectedCodes,
    freeText: a.freeText ?? null,
    answerState: a.answerState,
  }));
}
