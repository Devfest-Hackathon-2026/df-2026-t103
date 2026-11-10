import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from "firebase-admin/firestore";
import type {
  Deps,
  StoredObjectInfo,
  UploadUrlInstruction,
} from "../deps.js";
import type { UploadDoc } from "../domain/firestoreDocs.js";
import type { UploadInitBody } from "../domain/schemas.js";
import {
  UPLOAD_MAX_BYTES,
  uploadObjectPath,
} from "../domain/uploads.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { requestHash, runIdempotent } from "../lib/idempotency.js";
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { activeUploadsQuery, getUpload } from "../repos/uploads.js";
import { queryDocs } from "../repos/helpers.js";
import { latestOcrJobForUpload } from "../repos/ocrJobs.js";

export interface InitUploadResult {
  uploadId: string;
  status: "pending";
  upload: UploadUrlInstruction;
}

export interface CompleteUploadResult {
  uploadId: string;
  status: string;
}

export interface UploadProcessingResult {
  uploadId: string;
  status: string;
  ocrJob: {
    jobId: string;
    status: string;
    errorCode: string | null;
    candidateCount: number;
  } | null;
}

function timestampToDate(value: unknown): Date | undefined {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate(): Date }).toDate();
  }
  return undefined;
}

/**
 * API-019 POST /uploads/init。
 * 所有者スコープの objectPath に短命署名URLを発行する（02 §7, FR-M01）。
 */
export async function initUpload(
  deps: Deps,
  params: {
    uid: string;
    body: UploadInitBody;
    idempotencyKey: string;
    requestId?: string;
  },
): Promise<InitUploadResult> {
  const { body } = params;
  if (body.bytes > UPLOAD_MAX_BYTES) {
    throw new ApiError(
      413,
      ErrorCodes.FILE_TOO_LARGE,
      "ファイルサイズが上限（10MB）を超えています。",
    );
  }

  const { result, replayed } = await runIdempotent<{ uploadId: string }>(deps, {
    namespace: "upload_init",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, body),
    execute: async (tx) => {
      // 枚数上限（FR-M01）は新規作成時のみ。冪等リプレイは容量を消費せず
      // 既存の結果を再生する（上限到達後のリトライでも同一結果を返す）。
      const activeSnap = await tx.get(
        activeUploadsQuery(
          deps.db,
          params.uid,
          Timestamp.fromDate(deps.clock.now()),
        ),
      );
      if (activeSnap.size >= deps.config.uploadMaxActive) {
        throw ApiError.precondition(
          "アップロード件数が上限に達しています。不要な画像を削除してからやり直してください。",
        );
      }
      const ref = deps.db.collection("uploads").doc();
      const now = deps.clock.now();
      const doc: UploadDoc = {
        patientUid: params.uid,
        storageBucket: deps.config.storageBucket,
        objectPath: uploadObjectPath(params.uid, ref.id),
        mimeType: body.mimeType,
        bytes: body.bytes,
        sha256: body.sha256,
        status: "pending",
        sourcePurpose: body.sourcePurpose,
        contentScanStatus: "pending",
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
        expiresAt: Timestamp.fromMillis(
          now.getTime() + deps.config.uploadDocTtlDays * 24 * 3600_000,
        ),
      };
      tx.create(ref, doc as unknown as DocumentData);
      return { uploadId: ref.id };
    },
  });

  // 署名URLの発行はトランザクション外（外部APIをtx内で呼ばない、04 §9.1）
  const upload = await getUpload(deps.db, result.uploadId);
  if (!upload) {
    throw new ApiError(500, "INTERNAL", "アップロードの作成に失敗しました。");
  }
  const urlExpiry = new Date(
    Math.min(
      deps.clock.now().getTime() + deps.config.uploadUrlTtlSeconds * 1000,
      timestampToDate(upload.expiresAt)?.getTime() ?? Number.MAX_SAFE_INTEGER,
    ),
  );
  const instruction = await deps.storage.createUploadUrl({
    bucket: upload.storageBucket,
    objectPath: upload.objectPath,
    mimeType: upload.mimeType,
    expiresAt: urlExpiry,
  });

  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, params.uid),
    action: AUDIT_ACTIONS.UPLOAD_INIT,
    resourceType: "uploads",
    resourceIdHash: auditResourceHash(deps, result.uploadId),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    // リプレイ時も署名URLは新規発行されるため、証跡として残すが outcome は区別する
    outcome: replayed ? "url_reissued" : "created",
  });

  return { uploadId: result.uploadId, status: "pending", upload: instruction };
}

/**
 * API-020 POST /uploads/{id}/complete。
 * クライアント申告ではなくサーバが object の存在・サイズ・MIME・内容を検証する（04 §7.3）。
 */
export async function completeUpload(
  deps: Deps,
  params: {
    uid: string;
    uploadId: string;
    idempotencyKey: string;
    requestId: string;
  },
): Promise<CompleteUploadResult> {
  const upload = await getUpload(deps.db, params.uploadId);
  // 他人のリソースは存在自体を秘匿する（T-13, E2E-004）
  if (!upload || upload.patientUid !== params.uid) {
    throw ApiError.notFound("アップロードが見つかりません。");
  }

  if (upload.status === "uploaded") {
    // 冪等: 既に確定済みなら現在状態を返す（OCR起動は初回遷移時のみ）
    return { uploadId: params.uploadId, status: "uploaded" };
  }
  if (upload.status !== "pending") {
    throw ApiError.precondition(
      "このアップロードは利用できない状態です。別の画像でやり直してください。",
    );
  }
  const expiresAt = timestampToDate(upload.expiresAt);
  if (expiresAt && expiresAt.getTime() <= deps.clock.now().getTime()) {
    // 既にオブジェクトが置かれている可能性があるため、sweep が
    // tombstone できるよう objectCleanup=pending を残す。
    await deps.db.doc(`uploads/${params.uploadId}`).update({
      status: "expired",
      objectCleanup: "pending",
      updatedAt: FieldValue.serverTimestamp(),
    });
    throw ApiError.precondition(
      "アップロードの有効期限が切れています。もう一度やり直してください。",
    );
  }

  const verify = async (): Promise<StoredObjectInfo> => {
    const info = await deps.storage.inspectObject(
      upload.storageBucket,
      upload.objectPath,
    );
    if (!info) {
      throw ApiError.precondition(
        "ファイルが見つかりません。アップロードを完了してください。",
      );
    }

    // 実オブジェクトと申告の不一致は終端状態（宣言時点の指定が誤りだったため
    // このアップロードは有効にならない）。rejected にして内容を tombstone 化
    // する（実体削除すると create-only URL が再び使えてしまうため占有維持）。
    const reject = async (reason: string, error: ApiError): Promise<never> => {
      await rejectUpload(deps, params.uploadId, reason);
      // tombstone 失敗時は objectCleanup=pending が残り sweep が再試行する
      try {
        await deps.storage.tombstoneObject(
          upload.storageBucket,
          upload.objectPath,
        );
        await deps.db.doc(`uploads/${params.uploadId}`).update({
          objectCleanup: "done",
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        deps.logger.warn(
          { err, uploadId: params.uploadId },
          "rejected object cleanup failed",
        );
      }
      throw error;
    };

    if (info.sizeBytes > UPLOAD_MAX_BYTES) {
      await reject(
        "size_limit_exceeded",
        new ApiError(
          413,
          ErrorCodes.FILE_TOO_LARGE,
          "ファイルサイズが上限（10MB）を超えています。",
        ),
      );
    }
    if (info.sizeBytes !== upload.bytes) {
      await reject(
        "size_mismatch",
        ApiError.validation([
          {
            field: "bytes",
            message: "アップロードされたファイルのサイズが一致しません。",
          },
        ]),
      );
    }
    if (info.contentType !== undefined && info.contentType !== upload.mimeType) {
      await reject(
        "mime_mismatch",
        ApiError.validation([
          {
            field: "mimeType",
            message: "アップロードされたファイルの形式が一致しません。",
          },
        ]),
      );
    }
    const scan = await deps.contentScanner.scanUpload({
      bucket: upload.storageBucket,
      objectPath: upload.objectPath,
      declaredMimeType: upload.mimeType,
      readPrefix: (maxBytes) =>
        deps.storage.readObjectPrefix(
          upload.storageBucket,
          upload.objectPath,
          maxBytes,
        ),
    });
    if (scan.verdict === "rejected") {
      await reject(
        scan.reason ?? "content_rejected",
        ApiError.validation([
          {
            field: "file",
            message:
              "このファイルは受け付けられません。画像またはPDFを確認してください。",
          },
        ]),
      );
    }
    return info;
  };

  const objectInfo = await verify();

  let transitioned = false;
  const { result, replayed } = await runIdempotent<CompleteUploadResult>(deps, {
    namespace: "upload_complete",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, { uploadId: params.uploadId }),
    execute: async (tx) => {
      // tx リトライ時に前試行の状態が残らないよう各試行でリセット
      transitioned = false;
      const ref = deps.db.doc(`uploads/${params.uploadId}`);
      const snap = await tx.get(ref);
      const doc = snap.data() as UploadDoc | undefined;
      if (!snap.exists || !doc || doc.patientUid !== params.uid) {
        throw ApiError.notFound("アップロードが見つかりません。");
      }
      if (doc.status === "uploaded") {
        return { uploadId: params.uploadId, status: "uploaded" };
      }
      if (doc.status !== "pending") {
        throw ApiError.precondition(
          "このアップロードは利用できない状態です。",
        );
      }
      transitioned = true;
      tx.update(ref, {
        status: "uploaded",
        objectGeneration: objectInfo.generation,
        objectMd5HashBase64: objectInfo.md5HashBase64 ?? null,
        contentScanStatus: "passed",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { uploadId: params.uploadId, status: "uploaded" };
    },
  });

  // complete 確定後に非同期処理（OCR）を起動する。失敗しても complete は成功扱い。
  if (deps.uploadCompletion) {
    try {
      await deps.uploadCompletion.onUploadCompleted({
        uploadId: params.uploadId,
        patientUid: params.uid,
      });
    } catch (err) {
      deps.logger.warn(
        { err, uploadId: params.uploadId },
        "upload completion hook failed",
      );
    }
  }

  // 冪等リプレイ・既 uploaded の早期 return では状態遷移が起きていないため監査は発行しない
  if (!replayed && transitioned) {
    await audit(deps, {
      actorType: "patient",
      actorUidHash: auditUidHash(deps, params.uid),
      action: AUDIT_ACTIONS.UPLOAD_COMPLETED,
      resourceType: "uploads",
      resourceIdHash: auditResourceHash(deps, params.uploadId),
      requestId: params.requestId,
      outcome: "uploaded",
    });
  }

  return result;
}

/**
 * API-021 GET /uploads/{id}/processing。
 * OCR進捗は非PHIのステータス列のみ返す（04 §6.2, FR-O05）。
 */
export async function getUploadProcessing(
  deps: Deps,
  params: { uid: string; uploadId: string },
): Promise<UploadProcessingResult> {
  const upload = await getUpload(deps.db, params.uploadId);
  if (!upload || upload.patientUid !== params.uid) {
    throw ApiError.notFound("アップロードが見つかりません。");
  }
  const job = await latestOcrJobForUpload(deps.db, params.uploadId);
  return {
    uploadId: params.uploadId,
    status: upload.status,
    // 非PHIのみ返す: 患者識別子・薬剤名・OCR本文は含めない（FR-O05, 04 §6.2）
    ocrJob: job
      ? {
          jobId: job.id,
          status: job.data.status,
          errorCode: job.data.errorCode,
          candidateCount: job.data.candidates.length,
        }
      : null,
  };
}

async function rejectUpload(
  deps: Deps,
  uploadId: string,
  reason: string,
): Promise<void> {
  await deps.db.doc(`uploads/${uploadId}`).update({
    status: "rejected",
    contentScanStatus: "failed",
    rejectedReason: reason,
    // 呼び出し側が tombstone する。失敗したままなら sweep が再試行する。
    objectCleanup: "pending",
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * 保持期限切れの pending/uploaded アップロードを expired に遷移させ、
 * 実体を tombstone 化する（Scheduler → /v1/internal/jobs/upload-expiry-scan）。
 * complete されず放置されたオブジェクトが期限後も残らないようにする（FR-M06）。
 * rejected 化と同様に実体削除ではなく tombstone: create-only URL が
 * 有効期限内に残っていても generation は占有されたままになる。
 */
export async function sweepExpiredUploads(
  deps: Deps,
  limit = 200,
): Promise<{ scanned: number; expired: number; cleaned: number }> {
  const now = Timestamp.fromDate(deps.clock.now());
  // 終端 doc が limit を消費しないよう、対象ステータスをクエリ条件に含める
  // （pending/uploaded のみが expired 遷移の対象）。
  const stale = await queryDocs<UploadDoc>(
    deps.db,
    "uploads",
    [
      { field: "status", op: "in", value: ["pending", "uploaded"] },
      { field: "expiresAt", op: "<=", value: now },
    ],
    { orderBy: [{ field: "expiresAt" }], limit },
  );
  let expired = 0;
  for (const d of stale) {
    await deps.db.doc(`uploads/${d.id}`).update({
      status: "expired",
      // tombstone 失敗に備えてリトライ状態を残す
      objectCleanup: "pending",
      updatedAt: now,
    });
    expired++;
  }
  // tombstone 待ちを処理。失敗したものは pending のまま残り
  // 次回スキャンで再試行される（complete/reject 経路で付いた pending も拾う）。
  const pendingCleanup = await queryDocs<UploadDoc>(
    deps.db,
    "uploads",
    [{ field: "objectCleanup", op: "==", value: "pending" }],
    { limit },
  );
  let cleaned = 0;
  for (const d of pendingCleanup) {
    try {
      await deps.storage.tombstoneObject(
        d.data.storageBucket,
        d.data.objectPath,
      );
      await deps.db
        .doc(`uploads/${d.id}`)
        .update({ objectCleanup: "done", updatedAt: now });
      cleaned++;
    } catch (err) {
      deps.logger.warn(
        { err, uploadId: d.id },
        "expired object tombstone failed",
      );
    }
  }
  return {
    scanned: new Set([
      ...stale.map((d) => d.id),
      ...pendingCleanup.map((d) => d.id),
    ]).size,
    expired,
    cleaned,
  };
}
