import type { AppConfig } from "./config.js";
import type { Clock } from "./lib/clock.js";
import type { RateLimiter } from "./lib/rateLimit.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
} from "./domain/types.js";
import type { OcrEngineResult } from "./domain/ocr.js";
import type { FirestoreLike } from "./repos/helpers.js";
import type { FastifyBaseLogger } from "fastify";
import type {
  LlmQuestion,
  NormalizedAnswer,
} from "./ai/questionSchema.js";

/** Firebase Auth 管理操作（サービス層から見える最小IF）。 */
export interface AuthAdmin {
  createUser(props: {
    uid: string;
    email: string;
    password: string;
    emailVerified: boolean;
    disabled: boolean;
  }): Promise<{ uid: string }>;
  updateUser(
    uid: string,
    props: { disabled?: boolean; emailVerified?: boolean },
  ): Promise<unknown>;
  getUserByEmail(email: string): Promise<{ uid: string; disabled: boolean }>;
  deleteUser(uid: string): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

/** Storage 上の実オブジェクトの検証用メタ情報。 */
export interface StoredObjectInfo {
  generation: string;
  sizeBytes: number;
  contentType: string | undefined;
  md5HashBase64: string | null;
}

/** uploads/init が返す短命アップロード指示。 */
export interface UploadUrlInstruction {
  /** 本番署名URLはPUT。Storage Emulator のメディアアップロードはPOST。 */
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  /** ISO8601。URLの有効期限。 */
  expiresAt: string;
}

/** Cloud Storage(Firebase) アクセスIF。テストではインメモリ実装を注入する。 */
export interface StorageGateway {
  /** 対象が存在しなくても成功として扱う。generation 指定時は一致を確認。 */
  deleteObject(
    bucket: string,
    objectPath: string,
    generation?: string,
  ): Promise<void>;
  /**
   * 内容を空に置き換えパスを占有したままにする（rejected オブジェクト用）。
   * 実体削除すると create-only URL の ifGenerationMatch=0 が再び成立し、
   * URL 有効期限内の再 PUT で拒否済みパスを再作成できてしまう。
   */
  tombstoneObject(bucket: string, objectPath: string): Promise<void>;
  /** オブジェクトのメタ情報を取得。存在しなければ null。 */
  inspectObject(
    bucket: string,
    objectPath: string,
  ): Promise<StoredObjectInfo | null>;
  /** 所有者スコープ済み objectPath への短命アップロードURLを発行する。 */
  createUploadUrl(params: {
    bucket: string;
    objectPath: string;
    mimeType: string;
    expiresAt: Date;
  }): Promise<UploadUrlInstruction>;
  /** 内容チェック用に先頭バイトを読む（最大 maxBytes）。 */
  readObjectPrefix(
    bucket: string,
    objectPath: string,
    maxBytes: number,
  ): Promise<Uint8Array>;
  /** オブジェクト全体を読む（上限10MBの範囲内の利用を前提）。 */
  readObject(bucket: string, objectPath: string): Promise<Uint8Array>;
}

/**
 * アップロード内容チェックフック（FR-M01, SEC-07）。
 * ウイルススキャン等の外部検査は本IFの別実装として接続する。
 */
export interface ContentScanner {
  scanUpload(params: {
    bucket: string;
    objectPath: string;
    declaredMimeType: string;
    readPrefix: (maxBytes: number) => Promise<Uint8Array>;
  }): Promise<{ verdict: "clean" | "rejected"; reason?: string }>;
}

/**
 * uploads complete 後の非同期処理フック（OCR起動など）。
 * サービス層は存在すれば呼ぶ。内部で失敗しても complete 自体は成功させる。
 */
export interface UploadCompletionHook {
  onUploadCompleted(params: {
    uploadId: string;
    patientUid: string;
  }): Promise<void>;
}

/**
 * OCRエンジンアダプタ（02 §8, ADR-010）。実エンジン未調達のため dummy を既定とし、
 * 画像認識/OCRサービス確定後に本IFの実装として差し替える。
 */
export interface OcrEngine {
  readonly name: string;
  extract(params: {
    mimeType: string;
    readObject: () => Promise<Uint8Array>;
  }): Promise<OcrEngineResult>;
}

/**
 * OCRジョブの非同期起動IF。本番は Cloud Tasks（OIDC付きHTTPタスク）で
 * /v1/internal/jobs/ocr/:jobId/run を呼ぶ。エミュレータは同プロセス内で即時実行。
 */
export interface OcrTaskQueue {
  enqueueOcrJob(jobId: string): Promise<void>;
}

/** LLMへの構造化入力（PHIは匿名化済みの問診データのみ）。 */
export interface QuestionGenInput {
  symptomText: string;
  bodyLocations: string[];
  locale: string;
  /** 正規化済みの回答JSON。推測で埋めない。 */
  answers: NormalizedAnswer[];
  /** 既出トピック（重複生成の抑止）。 */
  askedTopics: string[];
  /** まだ未質問の収集トピック。 */
  remainingTopics: string[];
  /** これ以上生成してよい質問数の上限。 */
  maxQuestions: number;
}

export interface QuestionGenOutput {
  questions: LlmQuestion[];
  /** モデル/プロンプト版。APIキー・患者内容は含めない。 */
  modelVersion: string;
}

/**
 * 問診AIアダプタ（FR-I03/I04）。
 * 実装は Vertex AI（本番）・dummy（開発/試験）。
 * 出力はサービス側で JSON Schema + 禁則検査を必ず通す。
 */
export interface LlmAdapter {
  readonly name: string;
  generateQuestions(input: QuestionGenInput): Promise<QuestionGenOutput>;
}

export interface Deps {
  config: AppConfig;
  db: FirestoreLike;
  auth: AuthVerifier;
  authAdmin: AuthAdmin;
  appCheck: AppCheckVerifier;
  storage: StorageGateway;
  contentScanner: ContentScanner;
  ocrEngine: OcrEngine;
  ocrQueue: OcrTaskQueue;
  llmAdapter: LlmAdapter;
  uploadCompletion?: UploadCompletionHook;
  rateLimiter: RateLimiter;
  clock: Clock;
  logger: FastifyBaseLogger;
}
