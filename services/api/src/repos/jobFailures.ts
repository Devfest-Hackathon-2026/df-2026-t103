import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { DeletionJobDoc, OcrJobDoc } from "../domain/firestoreDocs.js";
import { hmacSha256Hex } from "../lib/hash.js";
import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from "../lib/opaqueCursor.js";
import { queryDocs } from "./helpers.js";

/**
 * 失敗ジョブ一覧（API-038, FR-O04）。
 * patientUid / subjectUid / uploadId などの個人紐付け識別子は
 * 返さない。一覧は jobId・失敗分類・時刻のみ。
 * nextCursor はdocパスを暗号化した不透明トークンで、内部IDを漏らさない。
 */
export interface JobFailureItem {
  type: "ocr" | "deletion";
  jobId: string;
  failureCode: string | null;
  attempts: number;
  /** ISO8601。時刻未設定の場合は null。 */
  failedAt: string | null;
}

export interface JobFailurePage {
  items: JobFailureItem[];
  nextCursor: string | null;
}

const toIsoOrNull = (v: unknown): string | null => {
  if (
    v !== null &&
    typeof v === "object" &&
    "toDate" in v &&
    typeof (v as { toDate?: unknown }).toDate === "function"
  ) {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
};

const OCR_PSEUDONYM_RE = /^oj_[0-9a-f]{64}$/;

/**
 * OCR jobId の表示値。現行の `oj_` 擬名IDはそのまま返す。
 * 旧形式（doc ID = uploadId）や外来IDは uploadId 露出を防ぐため
 * 同じ HMAC スキームで再擬名化する（FR-O04）。
 */
function displayOcrJobId(deps: Deps, docId: string): string {
  if (OCR_PSEUDONYM_RE.test(docId)) return docId;
  return `oj_${hmacSha256Hex(deps.config.hmacSecret, `ocr-job:${docId}`)}`;
}

/**
 * 不透明カーソルの解決。復号失敗・対象外コレクション・
 * 失敗状態でない・ソートキー欠落のいずれも空ページ。
 */
async function resolveCursor(
  deps: Deps,
  token: string,
  collection: string,
  isValidCursorDoc: (data: Record<string, unknown>) => boolean,
): Promise<DocumentSnapshot | null> {
  const path = decodeOpaqueCursor(deps.config.hmacSecret, token);
  // "collection/docId" のみ許可（多セグメント・空セグメントを排除）
  if (path === null || !new RegExp(`^${collection}/[^/]+$`).test(path)) {
    return null;
  }
  const snap = await deps.db.doc(path).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!snap.exists || !data || !isValidCursorDoc(data)) return null;
  return snap;
}

/** OCR失敗ジョブ（updatedAt 降順）。 */
export async function listFailedOcrJobs(
  deps: Deps,
  opts: { cursor?: string; limit: number },
): Promise<JobFailurePage> {
  if (opts.limit < 1) return { items: [], nextCursor: null };
  let startAfterDoc: DocumentSnapshot | undefined;
  if (opts.cursor) {
    const cur = await resolveCursor(
      deps,
      opts.cursor,
      "ocrJobs",
      (d) => d["status"] === "failed" && d["updatedAt"] != null,
    );
    if (cur === null) return { items: [], nextCursor: null };
    startAfterDoc = cur;
  }
  const rows = await queryDocs<OcrJobDoc>(
    deps.db,
    "ocrJobs",
    [{ field: "status", op: "==", value: "failed" }],
    {
      orderBy: [{ field: "updatedAt", direction: "desc" }],
      ...(startAfterDoc ? { startAfterDoc } : {}),
      limit: opts.limit + 1,
    },
  );
  const items = rows.slice(0, opts.limit).map((r) => ({
    type: "ocr" as const,
    jobId: displayOcrJobId(deps, r.id),
    failureCode: r.data.errorCode,
    attempts: r.data.attempt,
    failedAt: toIsoOrNull(r.data.updatedAt),
  }));
  return {
    items,
    nextCursor:
      rows.length > opts.limit
        ? encodeOpaqueCursor(
            deps.config.hmacSecret,
            rows[opts.limit - 1]!.path,
          )
        : null,
  };
}

/** 削除失敗ジョブ（requestedAt 降順）。jobId はランダムauto-IDで非識別。 */
export async function listFailedDeletionJobs(
  deps: Deps,
  opts: { cursor?: string; limit: number },
): Promise<JobFailurePage> {
  if (opts.limit < 1) return { items: [], nextCursor: null };
  let startAfterDoc: DocumentSnapshot | undefined;
  if (opts.cursor) {
    const cur = await resolveCursor(
      deps,
      opts.cursor,
      "deletionJobs",
      (d) => d["status"] === "failed" && d["requestedAt"] != null,
    );
    if (cur === null) return { items: [], nextCursor: null };
    startAfterDoc = cur;
  }
  const rows = await queryDocs<DeletionJobDoc>(
    deps.db,
    "deletionJobs",
    [{ field: "status", op: "==", value: "failed" }],
    {
      orderBy: [{ field: "requestedAt", direction: "desc" }],
      ...(startAfterDoc ? { startAfterDoc } : {}),
      limit: opts.limit + 1,
    },
  );
  const items = rows.slice(0, opts.limit).map((r) => ({
    type: "deletion" as const,
    jobId: r.id,
    failureCode: r.data.lastErrorCode,
    attempts: r.data.attemptCount,
    failedAt: toIsoOrNull(r.data.lastStartedAt ?? r.data.requestedAt),
  }));
  return {
    items,
    nextCursor:
      rows.length > opts.limit
        ? encodeOpaqueCursor(
            deps.config.hmacSecret,
            rows[opts.limit - 1]!.path,
          )
        : null,
  };
}
