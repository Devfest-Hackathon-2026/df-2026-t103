import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { OcrJobDoc } from "../domain/firestoreDocs.js";
import { latestOcrJobForUpload } from "../repos/ocrJobs.js";

/**
 * uploads complete 後フック: ocrJobs を作成してキュー投入する（FR-O01）。
 * 同一 uploadId の進行中ジョブがあれば再利用（complete 冪等との整合）。
 * enqueue 失敗時は queued のまま残し、後続のスキャン/再実行で拾える状態にする。
 */
export async function createOcrJobForUpload(
  deps: Deps,
  params: { uploadId: string; patientUid: string },
): Promise<{ jobId: string; created: boolean }> {
  const existing = await latestOcrJobForUpload(deps.db, params.uploadId);
  if (
    existing &&
    (existing.data.status === "queued" || existing.data.status === "running")
  ) {
    return { jobId: existing.id, created: false };
  }

  const ref = deps.db.collection("ocrJobs").doc();
  const doc: OcrJobDoc = {
    uploadId: params.uploadId,
    patientUid: params.patientUid,
    status: "queued",
    engine: deps.ocrEngine.name,
    attempt: 0,
    errorCode: null,
    candidates: [],
    createdAt: Timestamp.fromDate(deps.clock.now()),
    updatedAt: Timestamp.fromDate(deps.clock.now()),
  };
  await ref.set(doc as unknown as DocumentData);

  try {
    await deps.ocrQueue.enqueueOcrJob(ref.id);
  } catch (err) {
    deps.logger.warn(
      { err, jobId: ref.id },
      "ocr job enqueue failed; job left queued",
    );
  }
  return { jobId: ref.id, created: true };
}
