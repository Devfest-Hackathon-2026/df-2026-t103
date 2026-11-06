import type { AppConfig } from "./config.js";
import type { Clock } from "./lib/clock.js";
import type { RateLimiter } from "./lib/rateLimit.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
} from "./domain/types.js";
import type { FirestoreLike } from "./repos/helpers.js";
import type { FastifyBaseLogger } from "fastify";

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
  method: "PUT";
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

export interface Deps {
  config: AppConfig;
  db: FirestoreLike;
  auth: AuthVerifier;
  authAdmin: AuthAdmin;
  appCheck: AppCheckVerifier;
  storage: StorageGateway;
  contentScanner: ContentScanner;
  uploadCompletion?: UploadCompletionHook;
  rateLimiter: RateLimiter;
  clock: Clock;
  logger: FastifyBaseLogger;
}
