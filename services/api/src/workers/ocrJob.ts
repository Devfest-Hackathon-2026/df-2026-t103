import { randomUUID } from "node:crypto";
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
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { getDoc } from "../repos/helpers.js";
import { notifyPatient } from "../services/notifications.js";

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

type ClaimResult =
  | { kind: "claimed"; job: OcrJobDoc; owner: string }
  | { kind: "not_found" }
  | { kind: "already_running" }
  | { kind: "already_terminal"; errorCode?: OcrFailureCode }
  // claim tx 内で新たに終端化した経路（監査発行のため既存終端と区別する）
  | {
      kind: "terminalized";
      errorCode: OcrFailureCode;
      patientUid: string;
    };

/**
 * OCRワーカー（02 §8, FR-O01〜O07）。Cloud Tasks の HTTP タスクまたは
 * エミュレータ内直接実行で呼ばれる。失敗は分類コードとして ocrJobs に記録し、
 * 候補は常に unconfirmed（自動確定しない、VAL-013）。
 * 進捗状態は非PHIのみ（患者識別子・薬剤名・画像内容を通知/状態に含めない、FR-O05）。
 * 実行権はトランザクション内のリースclaimで排他制御し、結果書き込みは
 * claim 所有者のみ許可する（二重配送・遅延完了での上書きを防止）。
 */
export class OcrWorker {
  constructor(private readonly deps: Deps) {}

  async runJob(jobId: string): Promise<OcrRunResult> {
    const claim = await this.claim(jobId);
    switch (claim.kind) {
      case "not_found":
        return { jobId, outcome: "not_found" };
      case "already_running":
        return { jobId, outcome: "already_running" };
      case "already_terminal":
        return {
          jobId,
          outcome: "already_terminal",
          ...(claim.errorCode !== undefined ? { errorCode: claim.errorCode } : {}),
        };
      case "terminalized":
        // claim tx が今回新たに終端化した経路。finish() を通らないため
        // ここで OCR_JOB_FAILED を記録する
        await audit(this.deps, {
          actorType: "service",
          actorUidHash: auditUidHash(this.deps, claim.patientUid),
          action: AUDIT_ACTIONS.OCR_JOB_FAILED,
          resourceType: "ocrJobs",
          resourceIdHash: auditResourceHash(this.deps, jobId),
          details: { errorCode: claim.errorCode },
        });
        return {
          jobId,
          outcome: "already_terminal",
          errorCode: claim.errorCode,
        };
    }
    const { job, owner } = claim;

    const upload = (
      await getDoc<UploadDoc>(this.deps.db, `uploads/${job.uploadId}`)
    ).data;
    if (!upload || upload.status !== "uploaded") {
      return this.finish(jobId, job, owner, {
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
        return this.finish(jobId, job, owner, {
          ok: false,
          code: "engine_unavailable",
          retryable: true,
        });
      }
      if (countPdfPages(bytes) > OCR_PDF_MAX_PAGES) {
        return this.finish(jobId, job, owner, {
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
    return this.finish(jobId, job, owner, result);
  }

  /**
   * 実行権をトランザクションでclaimする。queued → running(attempt+1, owner+lease)。
   * running の場合: リース有効なら already_running（他ワーカー実行中）。
   * リース切れなら放棄とみなし、attempt上限到達なら worker_interrupted で終端化、
   * 未到達なら自ワーカーが再claimして回収する。
   */
  private async claim(jobId: string): Promise<ClaimResult> {
    const owner = randomUUID();
    const ref = this.deps.db.doc(`ocrJobs/${jobId}`);
    const nowMs = this.deps.clock.now().getTime();
    const maxAttempts = this.deps.config.ocrMaxAttempts;
    const leaseUntil = Timestamp.fromMillis(nowMs + this.deps.config.ocrLeaseMs);
    const now = Timestamp.fromMillis(nowMs);

    return this.deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" } as const;
      const job = snap.data() as OcrJobDoc;

      if (job.status === "succeeded" || job.status === "failed") {
        return {
          kind: "already_terminal",
          ...(job.errorCode !== null ? { errorCode: job.errorCode } : {}),
        } as const;
      }

      if (job.status === "running") {
        const leaseMs =
          job.claimExpiresAt instanceof Timestamp
            ? job.claimExpiresAt.toMillis()
            : 0;
        if (leaseMs > nowMs) return { kind: "already_running" } as const;
        // リース切れ = 実行ワーカー放棄。上限到達なら中断として終端化する
        if (job.attempt >= maxAttempts) {
          await tx.update(ref, {
            status: "failed",
            errorCode: "worker_interrupted",
            finishedAt: now,
            updatedAt: now,
          });
          return {
            kind: "terminalized",
            errorCode: "worker_interrupted",
            patientUid: job.patientUid,
          } as const;
        }
        // 未到達ならこのまま再claim（下の共通claim処理へ）
      } else if (job.attempt >= maxAttempts) {
        // queued かつ attempt 上限到達（通常あり得ないが安全側で終端化）
        await tx.update(ref, {
          status: "failed",
          errorCode: "worker_interrupted",
          finishedAt: now,
          updatedAt: now,
        });
        return {
          kind: "terminalized",
          errorCode: "worker_interrupted",
          patientUid: job.patientUid,
        } as const;
      }

      const attempt = job.attempt + 1;
      await tx.update(ref, {
        status: "running",
        attempt,
        claimOwner: owner,
        claimExpiresAt: leaseUntil,
        startedAt: job.startedAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        kind: "claimed",
        job: {
          ...job,
          status: "running",
          attempt,
          claimOwner: owner,
          claimExpiresAt: leaseUntil,
        },
        owner,
      } as const;
    });
  }

  /**
   * 結果を書き込む。claim 所有者かつ running の場合のみ反映し、
   * 失効済み/二重実行の遅延完了は上書きしない。
   */
  private async finish(
    jobId: string,
    job: OcrJobDoc,
    owner: string,
    result: OcrEngineResult,
  ): Promise<OcrRunResult> {
    const attempt = job.attempt;
    const now = Timestamp.fromDate(this.deps.clock.now());
    const ref = this.deps.db.doc(`ocrJobs/${jobId}`);

    const update: Record<string, unknown> = {};
    let outcome: OcrRunResult["outcome"];
    let errorCode: OcrFailureCode | undefined;
    if (result.ok) {
      update.status = "succeeded";
      update.errorCode = null;
      update.candidates = result.candidates;
      update.finishedAt = now;
      update.updatedAt = now;
      if (result.extractedText !== undefined) {
        update.extractedText = result.extractedText.slice(0, OCR_TEXT_MAX_CHARS);
        update.extractedTextTruncated =
          result.extractedText.length > OCR_TEXT_MAX_CHARS;
      }
      outcome = "succeeded";
    } else {
      const retryable =
        result.retryable === true && attempt < this.deps.config.ocrMaxAttempts;
      // 再試行可能なら queued に戻す。dispatchState=pending にすることで
      // Cloud Tasks の再送とは別に、後続の enqueue でも回収できる状態にする。
      update.status = retryable ? "queued" : "failed";
      update.errorCode = result.code;
      update.finishedAt = retryable ? null : now;
      update.updatedAt = now;
      if (retryable) update.dispatchState = "pending";
      outcome = retryable ? "failed_retryable" : "failed_terminal";
      errorCode = result.code;
    }

    const applied = await this.deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.data() as OcrJobDoc;
      // リース所有者のみが結果を書ける（claim失効後の遅延完了を遮断）
      if (cur.status !== "running" || cur.claimOwner !== owner) return false;
      await tx.update(ref, update);
      return true;
    });
    if (!applied) return { jobId, outcome: "already_running" };

    if (result.ok) {
      await audit(this.deps, {
        actorType: "service",
        actorUidHash: auditUidHash(this.deps, job.patientUid),
        action: AUDIT_ACTIONS.OCR_JOB_SUCCEEDED,
        resourceType: "ocrJobs",
        resourceIdHash: auditResourceHash(this.deps, jobId),
        details: { candidateCount: result.candidates.length, attempt },
      });
    } else if (outcome === "failed_terminal") {
      await audit(this.deps, {
        actorType: "service",
        actorUidHash: auditUidHash(this.deps, job.patientUid),
        action: AUDIT_ACTIONS.OCR_JOB_FAILED,
        resourceType: "ocrJobs",
        resourceIdHash: auditResourceHash(this.deps, jobId),
        details: { errorCode: result.code, attempt },
      });
    }

    // 実遷移がコミットされた場合のみ通知（applied=true で claim 所有者のみ到達）。
    // 通知失敗はワーカー処理を止めない（notifyPatient 内部で握り潰す）。
    if (result.ok) {
      try {
        await notifyPatient(this.deps, {
          patientUid: job.patientUid,
          template: "OCR_EXTRACTION_READY",
          refId: jobId,
        });
      } catch (err) {
        this.deps.logger.warn({ err, jobId }, "ocr completion notify failed");
      }
    }
    return {
      jobId,
      outcome,
      ...(errorCode !== undefined ? { errorCode } : {}),
      attemptCount: attempt,
    };
  }
}
