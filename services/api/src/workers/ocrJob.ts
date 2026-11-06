import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { OcrJobDoc, UploadDoc } from "../domain/firestoreDocs.js";
import type { OcrFailureCode } from "../domain/types.js";
import {
  OCR_PDF_MAX_PAGES,
  OCR_TEXT_MAX_CHARS,
  type OcrEngineResult,
} from "../domain/ocr.js";
import { countPdfPages } from "../domain/uploads.js";
import { audit, auditUidHash } from "../lib/audit.js";
import { getDoc } from "../repos/helpers.js";
import { getOcrJob } from "../repos/ocrJobs.js";

export interface OcrRunResult {
  jobId: string;
  outcome:
    | "succeeded"
    | "failed_retryable"
    | "failed_terminal"
    | "already_running"
    | "already_terminal"
    | "not_found";
  errorCode?: OcrFailureCode;
  attemptCount?: number;
}

/**
 * OCRワーカー（02 §8, FR-O01〜O07）。Cloud Tasks の HTTP タスクまたは
 * エミュレータ内直接実行で呼ばれる。失敗は分類コードとして ocrJobs に記録し、
 * 候補は常に unconfirmed（自動確定しない、VAL-013）。
 * 進捗状態は非PHIのみ（患者識別子・薬剤名・画像内容を通知/状態に含めない、FR-O05）。
 */
export class OcrWorker {
  constructor(private readonly deps: Deps) {}

  async runJob(jobId: string): Promise<OcrRunResult> {
    const job = await getOcrJob(this.deps.db, jobId);
    if (!job) return { jobId, outcome: "not_found" };
    if (job.status === "succeeded" || job.status === "failed") {
      return {
        jobId,
        outcome: "already_terminal",
        ...(job.errorCode !== null ? { errorCode: job.errorCode } : {}),
      };
    }
    if (job.status === "running" && job.attempt >= this.deps.config.ocrMaxAttempts) {
      return { jobId, outcome: "already_running", attemptCount: job.attempt };
    }

    // running へ遷移（queued か attempt<max の running のみ。楽観的に attempt を進める）
    const claimed = await this.claim(jobId, job);
    if (!claimed) return { jobId, outcome: "already_running" };

    const upload = (
      await getDoc<UploadDoc>(this.deps.db, `uploads/${job.uploadId}`)
    ).data;
    if (!upload || upload.status !== "uploaded") {
      return this.finish(jobId, job, {
        ok: false,
        code: "upload_invalid",
      });
    }

    const readObject = () =>
      this.deps.storage.readObject(upload.storageBucket, upload.objectPath);

    // PDF 暫定ページ上限チェック（02 §7）
    if (upload.mimeType === "application/pdf") {
      let bytes: Uint8Array;
      try {
        bytes = await readObject();
      } catch {
        return this.finish(jobId, job, {
          ok: false,
          code: "engine_unavailable",
          retryable: true,
        });
      }
      if (countPdfPages(bytes) > OCR_PDF_MAX_PAGES) {
        return this.finish(jobId, job, {
          ok: false,
          code: "page_limit_exceeded",
        });
      }
    }

    let result: OcrEngineResult;
    try {
      result = await this.deps.ocrEngine.extract({
        mimeType: upload.mimeType,
        readObject,
      });
    } catch (err) {
      this.deps.logger.warn({ err, jobId }, "ocr engine threw");
      result = { ok: false, code: "engine_unavailable", retryable: true };
    }
    return this.finish(jobId, job, result);
  }

  /** status を running に進め attempt+1。条件を満たさなければ false。 */
  private async claim(jobId: string, job: OcrJobDoc): Promise<boolean> {
    if (job.status === "running" && job.attempt >= this.deps.config.ocrMaxAttempts) {
      return false;
    }
    await this.deps.db.doc(`ocrJobs/${jobId}`).update({
      status: "running",
      attempt: job.attempt + 1,
      startedAt:
        job.startedAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  }

  private async finish(
    jobId: string,
    job: OcrJobDoc,
    result: OcrEngineResult,
  ): Promise<OcrRunResult> {
    const attempt = job.attempt + 1;
    const now = Timestamp.fromDate(this.deps.clock.now());

    if (result.ok) {
      const update: Record<string, unknown> = {
        status: "succeeded",
        errorCode: null,
        candidates: result.candidates,
        finishedAt: now,
        updatedAt: now,
      };
      if (result.extractedText !== undefined) {
        update.extractedText = result.extractedText.slice(0, OCR_TEXT_MAX_CHARS);
        update.extractedTextTruncated =
          result.extractedText.length > OCR_TEXT_MAX_CHARS;
      }
      await this.deps.db.doc(`ocrJobs/${jobId}`).update(update);
      await audit(this.deps, {
        actorType: "service",
        action: "OCR_JOB_SUCCEEDED",
        resourceType: "ocrJobs",
        resourceIdHash: jobId,
        details: {
          candidateCount: result.candidates.length,
          attempt,
        },
      });
      return { jobId, outcome: "succeeded", attemptCount: attempt };
    }

    const retryable = result.retryable === true && attempt < this.deps.config.ocrMaxAttempts;
    await this.deps.db.doc(`ocrJobs/${jobId}`).update({
      // 再試行可能なら queued に戻してタスク再投入を待つ。終端は failed。
      status: retryable ? "queued" : "failed",
      errorCode: result.code,
      finishedAt: retryable ? null : now,
      updatedAt: now,
    });
    if (!retryable) {
      await audit(this.deps, {
        actorType: "service",
        actorUidHash: auditUidHash(this.deps, job.patientUid),
        action: "OCR_JOB_FAILED",
        resourceType: "ocrJobs",
        resourceIdHash: jobId,
        details: { errorCode: result.code, attempt },
      });
    }
    return {
      jobId,
      outcome: retryable ? "failed_retryable" : "failed_terminal",
      errorCode: result.code,
      attemptCount: attempt,
    };
  }
}
