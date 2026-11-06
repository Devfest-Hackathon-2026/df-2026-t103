import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { OcrJobDoc } from "../domain/firestoreDocs.js";
import { latestOcrJobForUpload, ocrJobRef } from "../repos/ocrJobs.js";

/**
 * uploads complete 後フック: ocrJobs を作成してキュー投入する（FR-O01）。
 * 同一 uploadId の進行中ジョブがあれば再利用（complete 冪等との整合）。
 * enqueue は dispatchState で追跡し、未完了(pending)の queued ジョブは
 * 後続の呼び出しで再投入して回収する（enqueue 失敗で孤立しない）。
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
    // enqueue 未完了の queued ジョブは再投入して回収する
    if (
      existing.data.status === "queued" &&
      existing.data.dispatchState !== "enqueued"
    ) {
      await enqueue(deps, existing.id);
    }
    return { jobId: existing.id, created: false };
  }

  // ジョブIDは uploadId をそのまま使い create-if-absent で予約する。
  // 同時 complete 競合では一方のみが作成に成功し、他方は既存ジョブを再利用する
  // （ランダムIDだと二重ジョブが並走して処理状態の表示が不安定になる）。
  const ref = deps.db.doc(`ocrJobs/${params.uploadId}`);
  const doc: OcrJobDoc = {
    uploadId: params.uploadId,
    patientUid: params.patientUid,
    status: "queued",
    engine: deps.ocrEngine.name,
    attempt: 0,
    errorCode: null,
    candidates: [],
    dispatchState: "pending",
    createdAt: Timestamp.fromDate(deps.clock.now()),
    updatedAt: Timestamp.fromDate(deps.clock.now()),
  };
  try {
    await ref.create(doc as unknown as DocumentData);
  } catch (err) {
    // 既にジョブがある（同時作成 or 過去のジョブ）。最新を再利用する。
    const existing = await latestOcrJobForUpload(deps.db, params.uploadId);
    if (!existing) throw err; // 作成失敗が競合以外なら再送出
    if (
      existing.data.status === "queued" &&
      existing.data.dispatchState !== "enqueued"
    ) {
      await enqueue(deps, existing.id);
    }
    return { jobId: existing.id, created: false };
  }
  await enqueue(deps, ref.id);
  return { jobId: ref.id, created: true };
}

/** enqueue に成功したら dispatchState=enqueued にする。失敗は pending のまま。 */
async function enqueue(deps: Deps, jobId: string): Promise<void> {
  try {
    await deps.ocrQueue.enqueueOcrJob(jobId);
    await ocrJobRef(deps.db, jobId).update({
      dispatchState: "enqueued",
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    deps.logger.warn(
      { err, jobId },
      "ocr job enqueue failed; job left queued(dispatchState=pending)",
    );
  }
}
