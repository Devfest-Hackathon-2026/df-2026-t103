import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { DeletionJobDoc } from "../domain/firestoreDocs.js";
import type { DeletionStepStatus } from "../domain/types.js";
import type { DeletionStep } from "../domain/deletion.js";
import {
  CLAIM_TTL_MS,
  DELETION_STEPS,
  OVERDUE_ALERT_MS,
  retryDelayMs,
} from "../domain/deletion.js";
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import {
  deleteRecursive,
  deleteWhere,
  existsWhere,
  queryDocs,
} from "../repos/helpers.js";
import {
  findAbandonedJobs,
  findDueJobs,
  findFailedJobs,
} from "../repos/deletionJobs.js";

export interface JobRunResult {
  jobId: string;
  outcome:
    | "succeeded"
    | "failed_retryable"
    | "failed_terminal"
    | "not_due"
    | "already_running"
    | "already_terminal"
    | "not_found";
  failedStep?: DeletionStep;
  attemptCount?: number;
}

export interface ScanResult {
  scanned: number;
  executed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: JobRunResult[];
}

interface StorageObjectRef {
  bucket: string;
  path: string;
  generation?: string | undefined;
}

interface StepContext {
  uid: string;
  jobId: string;
  job: DeletionJobDoc;
}

interface StepOutcome {
  deletedCount?: number;
  note?: string;
}

/**
 * 退会削除ワーカー（04 §10.2, 02 §12, FR-A12, FR-O03）。
 * Firestore→Storage→Authの順序で削除し、ステップごとの状態・リトライを
 * deletionJobs/{jobId} に記録する。
 */
export class DeletionWorker {
  constructor(private readonly deps: Deps) {}

  /**
   * Cloud Scheduler 相当: 期限到来の scheduled ジョブと、
   * running のままクレーム失効した放置ジョブを列挙して実行する。
   */
  async scanDueJobs(): Promise<ScanResult> {
    const nowMs = this.deps.clock.now().getTime();
    const now = Timestamp.fromMillis(nowMs);
    const due = await findDueJobs(
      this.deps.db,
      now,
      this.deps.config.deletionScanBatchSize,
    );
    // ワーカー死亡で running のまま残ったジョブの回収スキャン
    const abandoned = await findAbandonedJobs(
      this.deps.db,
      Timestamp.fromMillis(nowMs - CLAIM_TTL_MS),
      this.deps.config.deletionScanBatchSize,
    );
    // 終端失敗ジョブは再実行されないが、未削除データが残るため
    // 期限超過アラート(SLO-07)の対象として走査する
    const failed = await findFailedJobs(
      this.deps.db,
      this.deps.config.deletionScanBatchSize,
    );
    for (const { id, data } of failed) {
      await this.alertIfOverdue(id, data).catch((err) =>
        this.deps.logger.warn({ err, jobId: id }, "overdue alert failed"),
      );
    }
    const results: JobRunResult[] = [];
    for (const { id, data } of [...due, ...abandoned]) {
      await this.alertIfOverdue(id, data).catch((err) =>
        this.deps.logger.warn({ err, jobId: id }, "overdue alert failed"),
      );
      results.push(await this.runJob(id));
    }
    const executed = results.filter(
      (r) => !["not_due", "already_running", "already_terminal", "not_found"].includes(r.outcome),
    ).length;
    return {
      scanned: due.length + abandoned.length,
      executed,
      succeeded: results.filter((r) => r.outcome === "succeeded").length,
      failed: results.filter((r) => r.outcome.startsWith("failed")).length,
      skipped: results.length - executed,
      results,
    };
  }

  /** Cloud Tasks 相当: 単一ジョブを冪等に実行する。 */
  async runJob(jobId: string): Promise<JobRunResult> {
    const claimed = await this.claim(jobId);
    if (claimed.outcome === "terminalized") {
      // claim tx が今回新たに終端化した経路。通常の fail() を通らないため
      // ここで失敗監査を記録する（クレーム放棄の最終到達点）
      await audit(this.deps, {
        actorType: "service",
        actorUidHash: auditUidHash(this.deps, claimed.subjectUid),
        action: AUDIT_ACTIONS.ACCOUNT_DELETION_FAILED,
        outcome: "failed_terminal",
        resourceType: "deletionJobs",
        resourceIdHash: auditResourceHash(this.deps, jobId),
        details: { errorClass: claimed.errorCode },
      });
      return { jobId, outcome: "already_terminal" };
    }
    if (claimed.outcome !== "claimed") {
      return { jobId, outcome: claimed.outcome };
    }
    const { job } = claimed;
    const uid = job.subjectUid;
    const ctx: StepContext = { uid, jobId, job };

    for (const step of DELETION_STEPS) {
      if (job.steps[step] === "succeeded") continue;
      await this.setStep(jobId, step, "running");
      try {
        const outcome = await this.executeStep(step, ctx);
        await this.completeStep(jobId, step, outcome);
      } catch (err) {
        return await this.fail(jobId, job, step, err);
      }
      job.steps[step] = "succeeded";
    }

    await this.deps.db.doc(`deletionJobs/${jobId}`).update({
      status: "succeeded",
      completedAt: FieldValue.serverTimestamp(),
    });
    await audit(this.deps, {
      actorType: "service",
      action: AUDIT_ACTIONS.ACCOUNT_PURGED,
      outcome: "succeeded",
      resourceType: "deletionJobs",
      resourceIdHash: auditResourceHash(this.deps, jobId),
      actorUidHash: auditUidHash(this.deps, uid),
      details: { attemptCount: job.attemptCount },
    });
    return { jobId, outcome: "succeeded", attemptCount: job.attemptCount };
  }

  // ---- ステップ実装 -------------------------------------------------------

  private async executeStep(
    step: DeletionStep,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    switch (step) {
      case "freeze":
        return this.stepFreeze(ctx);
      case "intakeSubcollections":
        return this.stepDeleteRecursiveByUid(ctx, "intakes");
      case "questionnaires":
        return this.stepDeleteRecursiveByUid(ctx, "questionnaires");
      case "medications":
        return this.stepMedications(ctx);
      case "uploads":
        return this.stepUploads(ctx);
      case "storageObjects":
        return this.stepStorageObjects(ctx);
      case "authAccount":
        return this.stepAuthAccount(ctx);
      case "residualScan":
        return this.stepResidualScan(ctx);
    }
  }

  /** pending_deletion を確認しトークンを失効させる。 */
  private async stepFreeze(ctx: StepContext): Promise<StepOutcome> {
    const accountRef = this.deps.db.doc(`accounts/${ctx.uid}`);
    const snap = await accountRef.get();
    if (snap.exists) {
      const account = snap.data() as { accountStatus?: string };
      if (account.accountStatus !== "pending_deletion") {
        await accountRef.update({
          accountStatus: "pending_deletion",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    try {
      await this.deps.authAdmin.revokeRefreshTokens(ctx.uid);
    } catch (err) {
      this.deps.logger.warn({ err }, "freeze: revokeRefreshTokens failed");
    }
    return { note: "account frozen" };
  }

  /** patientUid 一致のドキュメントをサブコレクション込みで再帰削除。 */
  private async stepDeleteRecursiveByUid(
    ctx: StepContext,
    collection: string,
  ): Promise<StepOutcome> {
    // 1000件超でも全件処理するまでページを回す（打ち切ると残骸が残る）
    let deleted = 0;
    for (;;) {
      const docs = await queryDocs<{ patientUid: string }>(
        this.deps.db,
        collection,
        [{ field: "patientUid", op: "==", value: ctx.uid }],
        { limit: 1000 },
      );
      if (docs.length === 0) break;
      for (const d of docs) {
        await deleteRecursive(this.deps.db, d.path);
      }
      deleted += docs.length;
      if (docs.length < 1000) break;
    }
    return { deletedCount: deleted };
  }

  /** medications と ocrJobs（candidates サブコレクション含む）。 */
  private async stepMedications(ctx: StepContext): Promise<StepOutcome> {
    const meds = await deleteWhere(this.deps.db, "medications", [
      { field: "patientUid", op: "==", value: ctx.uid },
    ]);
    const jobs = await queryDocs(this.deps.db, "ocrJobs", [
      { field: "patientUid", op: "==", value: ctx.uid },
    ]);
    for (const j of jobs) {
      await deleteRecursive(this.deps.db, j.path);
    }
    return { deletedCount: meds + jobs.length };
  }

  /**
   * uploads を削除し、対応 Storage オブジェクト参照をジョブへ退避する。
   * 参照はドキュメント削除「前」に永続化する。削除中に失敗しても
   * 既削除ドキュメント分の参照が失われず、リトライで収束できる。
   */
  private async stepUploads(ctx: StepContext): Promise<StepOutcome> {
    const uploads = await queryDocs<{
      storageBucket?: string;
      objectPath?: string;
      objectGeneration?: string | number;
    }>(this.deps.db, "uploads", [
      { field: "patientUid", op: "==", value: ctx.uid },
    ]);
    const ref = this.deps.db.doc(`deletionJobs/${ctx.jobId}`);

    // 1. 参照を先にジョブへ永続化（既存の退避分とマージ・重複排除）
    const snap = await ref.get();
    const existing =
      (snap.data() as DeletionJobDoc | undefined)?.pendingStorageObjects ?? [];
    const merged = new Map<string, StorageObjectRef>();
    for (const o of existing) {
      merged.set(`${o.bucket}/${o.path}/${o.generation ?? ""}`, o);
    }
    for (const u of uploads) {
      if (!u.data.objectPath) continue;
      const obj: StorageObjectRef = {
        bucket: u.data.storageBucket ?? this.deps.config.storageBucket,
        path: u.data.objectPath,
        generation:
          u.data.objectGeneration !== undefined
            ? String(u.data.objectGeneration)
            : undefined,
      };
      merged.set(`${obj.bucket}/${obj.path}/${obj.generation ?? ""}`, obj);
    }
    await ref.update({ pendingStorageObjects: [...merged.values()] });

    // 2. 参照の永続化後にドキュメントを削除する
    for (const u of uploads) {
      await this.deps.db.doc(u.path).delete();
    }
    return { deletedCount: uploads.length };
  }

  /**
   * uploads ステップが退避した Storage オブジェクトを削除する。
   * 失敗したオブジェクトは pendingStorageObjects に残したままステップを
   * 失敗させ、既存のリトライ機構に委ねる（成功扱いにすると画像が残る）。
   */
  private async stepStorageObjects(ctx: StepContext): Promise<StepOutcome> {
    const ref = this.deps.db.doc(`deletionJobs/${ctx.jobId}`);
    const snap = await ref.get();
    const objects =
      (snap.data() as DeletionJobDoc | undefined)?.pendingStorageObjects ?? [];
    let deleted = 0;
    const remaining: StorageObjectRef[] = [];
    for (const obj of objects) {
      try {
        await this.deps.storage.deleteObject(obj.bucket, obj.path, obj.generation);
        deleted += 1;
      } catch (err) {
        remaining.push(obj);
        this.deps.logger.warn(
          { err, jobId: ctx.jobId },
          "storage object delete failed",
        );
      }
    }
    if (remaining.length > 0) {
      await ref.update({ pendingStorageObjects: remaining });
      throw new Error(
        `storage object deletions failed: ${remaining.length} of ${objects.length} remaining`,
      );
    }
    await ref.update({
      pendingStorageObjects: FieldValue.delete(),
    });
    return { deletedCount: deleted, note: `${objects.length} objects listed` };
  }

  /**
   * 認証アカウント削除と残る本人紐付けドキュメントの一括消去。
   * deliveries（医療機関保管分）・auditEvents（最小証跡）は除外（04 §10.1, RISK-05）。
   */
  private async stepAuthAccount(ctx: StepContext): Promise<StepOutcome> {
    const uid = ctx.uid;
    let count = 0;
    count += await deleteWhere(this.deps.db, "legalConsents", [
      { field: "subjectUid", op: "==", value: uid },
    ]);
    count += await deleteWhere(this.deps.db, "passkeyCredentials", [
      { field: "ownerUid", op: "==", value: uid },
    ]);
    count += await deleteWhere(this.deps.db, "facilityMemberships", [
      { field: "userUid", op: "==", value: uid },
    ]);
    count += await deleteWhere(this.deps.db, "registrationOperations", [
      { field: "uid", op: "==", value: uid },
    ]);
    await this.deps.db.doc(`patientProfiles/${uid}`).delete();
    await this.deps.db.doc(`accounts/${uid}`).delete();
    try {
      await this.deps.authAdmin.deleteUser(uid);
    } catch (err) {
      if (
        !(
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === "auth/user-not-found"
        )
      ) {
        throw err;
      }
    }
    return { deletedCount: count + 2, note: "auth account deleted" };
  }

  /** 残存探索: 本人紐付けドキュメントの残骸を除去して検証する。 */
  private async stepResidualScan(ctx: StepContext): Promise<StepOutcome> {
    const uid = ctx.uid;
    const checks: Array<{ collection: string; field: string }> = [
      { collection: "intakes", field: "patientUid" },
      { collection: "questionnaires", field: "patientUid" },
      { collection: "medications", field: "patientUid" },
      { collection: "uploads", field: "patientUid" },
      { collection: "ocrJobs", field: "patientUid" },
      { collection: "legalConsents", field: "subjectUid" },
      { collection: "passkeyCredentials", field: "ownerUid" },
      { collection: "facilityMemberships", field: "userUid" },
      { collection: "registrationOperations", field: "uid" },
    ];
    // 収集漏れを再削除してから検証（部分失敗からの収束）
    for (const c of checks) {
      await deleteWhere(this.deps.db, c.collection, [
        { field: c.field, op: "==", value: uid },
      ]);
    }
    await this.deps.db.doc(`patientProfiles/${uid}`).delete();
    await this.deps.db.doc(`accounts/${uid}`).delete();

    const leftovers: string[] = [];
    for (const c of checks) {
      if (
        await existsWhere(this.deps.db, c.collection, [
          { field: c.field, op: "==", value: uid },
        ])
      ) {
        leftovers.push(c.collection);
      }
    }
    for (const path of [`patientProfiles/${uid}`, `accounts/${uid}`]) {
      const snap = await this.deps.db.doc(path).get();
      if (snap.exists) leftovers.push(path);
    }
    if (leftovers.length > 0) {
      throw new Error(`residual documents remain: ${leftovers.join(",")}`);
    }
    // RTDB には個人識別データを置かない設計のため削除対象なし（04 §6.1）
    return { note: "no residual documents" };
  }

  // ---- ジョブ状態管理 ------------------------------------------------------

  private async claim(
    jobId: string,
  ): Promise<
    | { outcome: "claimed"; job: DeletionJobDoc }
    | { outcome: JobRunResult["outcome"] }
    // claim tx 内で新たに終端化した経路（監査発行のため区別する）
    | { outcome: "terminalized"; subjectUid: string; errorCode: string }
  > {
    const ref = this.deps.db.doc(`deletionJobs/${jobId}`);
    return this.deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: "not_found" as const };
      const job = snap.data() as DeletionJobDoc;
      const nowMs = this.deps.clock.now().getTime();

      if (job.status === "succeeded" || job.status === "cancelled") {
        return { outcome: "already_terminal" as const };
      }
      if (job.status === "running") {
        // 実行中クレームは CLAIM_TTL_MS で失効する。超過した running は
        // 前ワーカー死亡とみなして回収する（tx内なので同時回収は競合しない）。
        const startedMs = (
          job.lastStartedAt as { toMillis?: () => number } | undefined
        )?.toMillis?.();
        const stale =
          startedMs !== undefined && nowMs - startedMs > CLAIM_TTL_MS;
        if (!stale) {
          return { outcome: "already_running" as const };
        }
        if ((job.attemptCount ?? 0) >= this.deps.config.deletionJobMaxAttempts) {
          tx.update(ref, {
            status: "failed",
            lastErrorCode: "claim_abandoned",
          });
          return {
            outcome: "terminalized" as const,
            subjectUid: job.subjectUid,
            errorCode: "claim_abandoned",
          };
        }
      }
      if (job.status === "failed" && job.attemptCount >= this.deps.config.deletionJobMaxAttempts) {
        return { outcome: "already_terminal" as const };
      }
      const execMs = (job.executeAfter as { toMillis?: () => number } | undefined)?.toMillis?.();
      if (job.status === "scheduled" && execMs !== undefined && execMs > nowMs) {
        return { outcome: "not_due" as const };
      }

      const attemptCount = (job.attemptCount ?? 0) + 1;
      tx.update(ref, {
        status: "running",
        attemptCount,
        lastStartedAt: FieldValue.serverTimestamp(),
      });
      return {
        outcome: "claimed" as const,
        job: { ...job, attemptCount },
      };
    });
  }

  private async setStep(
    jobId: string,
    step: DeletionStep,
    status: DeletionStepStatus,
  ): Promise<void> {
    await this.deps.db.doc(`deletionJobs/${jobId}`).update({
      [`steps.${step}`]: status,
    });
  }

  private async completeStep(
    jobId: string,
    step: DeletionStep,
    outcome: StepOutcome,
  ): Promise<void> {
    await this.deps.db.doc(`deletionJobs/${jobId}`).update({
      [`steps.${step}`]: "succeeded",
      [`stepResults.${step}`]: {
        deletedCount: outcome.deletedCount ?? 0,
        note: outcome.note ?? null,
      },
    });
  }

  private async fail(
    jobId: string,
    job: DeletionJobDoc,
    step: DeletionStep,
    err: unknown,
  ): Promise<JobRunResult> {
    const errorClass =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : err instanceof Error
          ? err.name
          : "unknown";
    const terminal = job.attemptCount >= this.deps.config.deletionJobMaxAttempts;
    const now = this.deps.clock.now();

    const patch: Record<string, unknown> = {
      [`steps.${step}`]: "failed",
      lastErrorCode: errorClass,
    };
    let outcome: JobRunResult["outcome"];
    if (terminal) {
      patch.status = "failed";
      outcome = "failed_terminal";
    } else {
      patch.status = "scheduled";
      patch.executeAfter = Timestamp.fromMillis(
        now.getTime() + retryDelayMs(job.attemptCount),
      );
      patch.nextAttemptAt = patch.executeAfter;
      outcome = "failed_retryable";
    }
    await this.deps.db.doc(`deletionJobs/${jobId}`).update(patch);

    const logger = this.deps.logger;
    (terminal ? logger.error : logger.warn).call(
      logger,
      { jobId, step, errorClass, attemptCount: job.attemptCount },
      "deletion job step failed",
    );
    await audit(this.deps, {
      actorType: "service",
      action: AUDIT_ACTIONS.ACCOUNT_DELETION_FAILED,
      outcome: terminal ? "failed_terminal" : "failed_retryable",
      resourceType: "deletionJobs",
      resourceIdHash: auditResourceHash(this.deps, jobId),
      actorUidHash: auditUidHash(this.deps, job.subjectUid),
      details: { step, errorClass },
    });
    return {
      jobId,
      outcome,
      failedStep: step,
      attemptCount: job.attemptCount,
    };
  }

  /** SLO-07: 予定時刻+24hを超えた未完了ジョブをアラートする。 */
  private async alertIfOverdue(
    jobId: string,
    job: DeletionJobDoc,
  ): Promise<void> {
    // アンカーは「当初の削除予定時刻」。executeAfter はリトライ毎に
    // 前進するため失敗し続けるジョブが永遠にアラートされなくなるのを
    // 防ぐため requestedAt + 猶予期間から導出する（欠損時は executeAfter）
    const requestedMs = (
      job.requestedAt as { toMillis?: () => number } | undefined
    )?.toMillis?.();
    const graceMs =
      this.deps.config.deletionGracePeriodDays * 24 * 3600_000;
    const anchorMs =
      requestedMs !== undefined
        ? requestedMs + graceMs
        : (
            job.executeAfter as { toMillis?: () => number } | undefined
          )?.toMillis?.();
    if (anchorMs === undefined || job.overdueAlertedAt) return;
    const nowMs = this.deps.clock.now().getTime();
    if (nowMs - anchorMs <= OVERDUE_ALERT_MS) return;
    this.deps.logger.error(
      { jobId, overdueMs: nowMs - anchorMs },
      "deletion job overdue >24h — manual review required (SLO-07)",
    );
    // マーカー永続化を監査より先・未設定ガード付きtxで行い、
    // 並行スキャンや書込失敗での重複アラートを防ぐ
    const ref = this.deps.db.doc(`deletionJobs/${jobId}`);
    const marked = await this.deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()?.overdueAlertedAt) return false;
      await tx.update(ref, {
        overdueAlertedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!marked) return;
    await audit(this.deps, {
      actorType: "service",
      action: AUDIT_ACTIONS.DELETION_JOB_OVERDUE,
      outcome: "overdue_alert",
      resourceType: "deletionJobs",
      resourceIdHash: auditResourceHash(this.deps, jobId),
      actorUidHash: auditUidHash(this.deps, job.subjectUid),
    });
  }
}
