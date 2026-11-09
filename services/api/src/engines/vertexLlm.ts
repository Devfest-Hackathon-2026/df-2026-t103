import type {
  LlmAdapter,
  QuestionGenInput,
  QuestionGenOutput,
} from "../deps.js";
import {
  LLM_RESPONSE_SCHEMA,
  llmOutputSchema,
} from "../ai/questionSchema.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";

export interface VertexLlmConfig {
  apiKey: string;
  model: string;
  location: string;
  projectId: string;
  timeoutMs: number;
}

/** Preserve only the HTTP status for internal diagnostics, never the response or URL. */
class VertexHttpError extends ApiError {
  constructor(readonly upstreamStatus: number) {
    super(
      502,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "質問生成サービスがエラーを返しました。",
    );
  }
}

const SAFETY_INSTRUCTION = [
  "あなたは医療機関への問診を支援する質問生成器です。次の制約を厳守してください。",
  "- 病名の診断・推定、リスクの数値化、薬の処方・中止・変更の助言、受診要否の判定、緊急性の判定を含めない",
  "- 患者が答えやすい平易な日本語の質問のみ生成する",
  "- 各質問は2〜4個の選択肢を持ち、topicはsnake_case、選択肢codeは大英字+_",
  "- askedTopicsと重複しない。remainingTopicsから情報価値の高いものを優先する",
  "- 患者の原文をそのまま引用しない",
].join("\n");

function buildPrompt(input: QuestionGenInput): string {
  return [
    SAFETY_INSTRUCTION,
    "",
    "入力(JSON):",
    JSON.stringify({
      symptomText: input.symptomText,
      bodyLocations: input.bodyLocations,
      locale: input.locale,
      answers: input.answers,
      askedTopics: input.askedTopics,
      remainingTopics: input.remainingTopics,
      maxQuestions: input.maxQuestions,
    }),
    "",
    "次の質問を1〜3件、指定JSON形式のみで返してください。",
  ].join("\n");
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/**
 * Vertex AI (Gemini generateContent) アダプタ。
 * - responseSchema による構造化出力 + クライアント側の zod 再検証
 * - APIキーは Secret Manager → env 注入を想定（ログ・本文へ複製しない）
 * - タイムアウト・HTTP/解析失敗は ApiError として投げ、呼出側が fallback する
 */
export class VertexAiLlmAdapter implements LlmAdapter {
  readonly name = "vertex";

  constructor(private readonly cfg: VertexLlmConfig) {}

  private get endpoint(): string {
    const { location, projectId, model, apiKey } = this.cfg;
    return (
      `https://${location}-aiplatform.googleapis.com/v1/projects/` +
      `${projectId}/locations/${location}/publishers/google/models/` +
      `${model}:generateContent?key=${encodeURIComponent(apiKey)}`
    );
  }

  async generateQuestions(input: QuestionGenInput): Promise<QuestionGenOutput> {
    const body = {
      contents: [
        { role: "user", parts: [{ text: buildPrompt(input) }] },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: LLM_RESPONSE_SCHEMA,
        temperature: 0.2,
        maxOutputTokens: 800,
      },
    };
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new ApiError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        "質問生成サービスに接続できません。",
        { cause: err },
      );
    }
    if (!res.ok) {
      throw new VertexHttpError(res.status);
    }
    const json = (await res.json()) as GenerateContentResponse;
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text === undefined) {
      throw new ApiError(
        502,
        ErrorCodes.MODEL_SCHEMA_REJECTED,
        "質問生成の応答が空です。",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // cause を付けない: SyntaxError のメッセージにはモデル応答の断片が
      // 含まれ得るため、ログ経由で PHI 流出しうる（SEC ログ最小化）。
      throw new ApiError(
        502,
        ErrorCodes.MODEL_SCHEMA_REJECTED,
        "質問生成の応答がJSONではありません。",
      );
    }
    const out = llmOutputSchema.safeParse(parsed);
    if (!out.success) {
      throw ApiError.conflict(
        ErrorCodes.MODEL_SCHEMA_REJECTED,
        "質問生成の応答がスキーマに一致しません。",
      );
    }
    return {
      questions: out.data.questions,
      modelVersion: `${this.cfg.model}/${this.cfg.location}`,
    };
  }
}
