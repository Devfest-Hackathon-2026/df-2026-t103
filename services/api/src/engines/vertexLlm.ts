import { GoogleAuth } from "google-auth-library";
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
 * - Cloud Run実行SAのADCから短命OAuthトークンを取得（ログ・本文へ複製しない）
 * - タイムアウト・HTTP/解析失敗は ApiError として投げ、呼出側が fallback する
 */
export class VertexAiLlmAdapter implements LlmAdapter {
  readonly name = "vertex";

  private readonly accessToken: () => Promise<string | null>;

  constructor(
    private readonly cfg: VertexLlmConfig,
    accessToken?: () => Promise<string | null>,
  ) {
    const auth = new GoogleAuth({
      projectId: cfg.projectId,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    this.accessToken = accessToken ?? (async () => (await auth.getAccessToken()) ?? null);
  }

  private get endpoint(): string {
    const { location, projectId, model } = this.cfg;
    // Global uses the unprefixed host; the resource path still contains global.
    const host = location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
    return (
      `https://${host}/v1/projects/` +
      `${projectId}/locations/${location}/publishers/google/models/` +
      `${model}:generateContent`
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
    const signal = AbortSignal.timeout(this.cfg.timeoutMs);
    try {
      // Token acquisition shares the request deadline; ADC errors may contain
      // credentials or URLs and must never become a logged error cause.
      const token = await withDeadline(this.accessToken(), signal);
      if (!token) throw new Error("ADC returned no access token");
      signal.throwIfAborted();
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new ApiError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        "質問生成サービスに接続できません。",
        // ADC/fetch の例外はトークン、URL、request context を含み得る。
        // 呼出側は ApiError 自体をログするため、cause はログへ流さない。
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

/** Bound ADC lookup too, without retaining a timer after successful lookup. */
async function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
