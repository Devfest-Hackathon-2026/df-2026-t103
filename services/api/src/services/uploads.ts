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
import { audit, auditUidHash } from "../lib/audit.js";
import { countActiveUploads, getUpload } from "../repos/uploads.js";

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
  params: { uid: string; body: UploadInitBody; idempotencyKey: string },
): Promise<InitUploadResult> {
  const { body } = params;
  if (body.bytes > UPLOAD_MAX_BYTES) {
    throw new ApiError(
      413,
      ErrorCodes.FILE_TOO_LARGE,
      "ファイルサイズが上限（10MB）を超えています。",
    );
  }

  // 有効アップロード数の上限（FR-M01 枚数制限）。soft limitとしてトランザクション外で確認する。
  const active = await countActiveUploads(deps.db, params.uid);
  if (active >= deps.config.uploadMaxActive) {
    throw ApiError.precondition(
      "アップロード件数が上限に達しています。不要な画像を削除してからやり直してください。",
    );
  }

  const { result } = await runIdempotent<{ uploadId: string }>(deps, {
    namespace: "upload_init",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, body),
    execute: async (tx) => {
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
    action: "UPLOAD_INIT",
    resourceType: "uploads",
    resourceIdHash: result.uploadId,
    outcome: "created",
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
    await deps.db
      .doc(`uploads/${params.uploadId}`)
      .update({ status: "expired", updatedAt: FieldValue.serverTimestamp() });
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
    // このアップロードは有効にならない）。rejected にして実体を削除する。
    const reject = async (reason: string, error: ApiError): Promise<never> => {
      await rejectUpload(deps, params.uploadId, reason);
      await deps.storage
        .deleteObject(upload.storageBucket, upload.objectPath)
        .catch((err) =>
          deps.logger.warn(
            { err, uploadId: params.uploadId },
            "rejected object cleanup failed",
          ),
        );
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

  const { result } = await runIdempotent<CompleteUploadResult>(deps, {
    namespace: "upload_complete",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, { uploadId: params.uploadId }),
    execute: async (tx) => {
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

  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, params.uid),
    action: "UPLOAD_COMPLETED",
    resourceType: "uploads",
    resourceIdHash: params.uploadId,
    requestId: params.requestId,
    outcome: "uploaded",
  });

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
  return {
    uploadId: params.uploadId,
    status: upload.status,
    // OCRジョブの配線は ocr-worker issue で追加する
    ocrJob: null,
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
    updatedAt: FieldValue.serverTimestamp(),
  });
}
