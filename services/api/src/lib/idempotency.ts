import type { FastifyRequest } from "fastify";
import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { IdempotencyKeyDoc } from "../domain/firestoreDocs.js";
import { ApiError, ErrorCodes } from "./errors.js";
import { canonicalJson, hmacParts } from "./hash.js";
import { idempotencyKeyRef } from "../repos/operations.js";
import type { Transaction } from "../repos/helpers.js";

const KEY_MAX_LEN = 200;
const DEFAULT_TTL_HOURS = 24;

/** 副作用POSTに必須の Idempotency-Key ヘッダを取得・検証する。 */
export function requireIdempotencyKey(req: FastifyRequest): string {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.length > KEY_MAX_LEN || /\s/.test(key)) {
    throw ApiError.validation([
      { field: "Idempotency-Key", message: "Idempotency-Key ヘッダが必要です。" },
    ]);
  }
  return key;
}

/** Optional migration path for existing clients; supplied keys use the same validation. */
export function optionalIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  return requireIdempotencyKey(req);
}

export function requestHash(deps: Deps, body: unknown): string {
  return hmacParts(deps.config.hmacSecret, canonicalJson(body));
}

export function idempotencyKeyHash(
  deps: Deps,
  namespace: string,
  principal: string,
  key: string,
): string {
  return hmacParts(deps.config.hmacSecret, namespace, principal, key);
}

export interface IdempotentOutcome<T> {
  result: T;
  replayed: boolean;
}

/**
 * Firestore 内の副作用を単一トランザクションで冪等化する。
 * - 同一キー+同一requestHash → 保存済み結果を再生
 * - 同一キー+異なるrequestHash → 409
 * - 外部API呼出しを含む処理はこの関数を使わず専用台帳を使う（registrationOperations参照）
 */
export async function runIdempotent<T>(
  deps: Deps,
  params: {
    namespace: string;
    key: string;
    principal: string;
    requestHash: string;
    execute: (tx: Transaction) => Promise<T>;
    validateReplay?: (tx: Transaction) => Promise<void>;
    rejectExpiredReplay?: boolean;
    ttlHours?: number;
  },
): Promise<IdempotentOutcome<T>> {
  const keyHash = idempotencyKeyHash(
    deps,
    params.namespace,
    params.principal,
    params.key,
  );
  const ref = idempotencyKeyRef(deps.db, keyHash);
  const ttlMs = (params.ttlHours ?? DEFAULT_TTL_HOURS) * 3600_000;
  const TimestampImpl = Timestamp;

  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const doc = snap.data() as IdempotencyKeyDoc;
      if (doc.requestHash !== params.requestHash) {
        throw ApiError.conflict(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          "同じIdempotency-Keyで異なる内容が送信されました。",
        );
      }
      if (doc.status === "completed") {
        // Firestore TTL deletion is asynchronous. Callers which cannot safely
        // repeat an old operation may opt to reject at the logical deadline.
        if (
          params.rejectExpiredReplay &&
          (doc.expiresAt as Timestamp).toMillis() <= deps.clock.now().getTime()
        ) {
          throw ApiError.conflict(
            ErrorCodes.IDEMPOTENCY_CONFLICT,
            "このIdempotency-Keyの有効期限が切れました。新しいキーで再送してください。",
          );
        }
        await params.validateReplay?.(tx);
        return { result: doc.result as T, replayed: true };
      }
      throw new ApiError(
        409,
        ErrorCodes.IDEMPOTENCY_IN_PROGRESS,
        "同じリクエストを処理中です。しばらく待って再試行してください。",
        { retryable: true },
      );
    }
    const result = await params.execute(tx);
    const now = TimestampImpl.fromDate(deps.clock.now());
    const expiresAt = TimestampImpl.fromMillis(
      deps.clock.now().getTime() + ttlMs,
    );
    const doc: IdempotencyKeyDoc = {
      keyHash,
      requestHash: params.requestHash,
      status: "completed",
      result: (result ?? {}) as Record<string, unknown>,
      createdAt: now,
      expiresAt,
    };
    tx.create(ref, doc as unknown as DocumentData);
    return { result, replayed: false };
  });
}
