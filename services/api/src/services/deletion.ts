import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type {
  AccountDoc,
  DeletionJobDoc,
} from "../domain/firestoreDocs.js";
import { initialSteps } from "../domain/deletion.js";
import { ApiError } from "../lib/errors.js";
import { requestHash, runIdempotent } from "../lib/idempotency.js";
import {
  auditInTransaction,
  auditResourceHash,
  auditUidHash,
  logAuditEvent,
} from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import type { AuditEventDoc } from "../domain/firestoreDocs.js";
import { getAccount } from "../repos/accounts.js";
import { getDeletionJob } from "../repos/deletionJobs.js";

export interface DeletionStatusBody {
  status: "none" | "pending_deletion" | "processing" | "completed" | "cancelled";
  requestedAt?: string | undefined;
  scheduledForDeletionAt?: string | undefined;
  cancelDeadline?: string | undefined;
  canCancel: boolean;
  jobStatus?: string | undefined;
}

function toIso(value: unknown): string | undefined {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  return undefined;
}

function jobStatusToBody(
  status: DeletionJobDoc["status"] | undefined,
): DeletionStatusBody["status"] {
  switch (status) {
    case "scheduled":
      return "pending_deletion";
    case "running":
      return "processing";
    case "succeeded":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending_deletion";
  }
}

/**
 * API-008 GET /me/deletion-request。退会状況と取消可否を返す。
 */
export async function getDeletionStatus(
  deps: Deps,
  uid: string,
): Promise<DeletionStatusBody> {
  const account = await getAccount(deps.db, uid);
  if (!account || account.accountStatus !== "pending_deletion") {
    const jobId = account?.deletionJobId ?? account?.lastDeletionJobId;
    const job = jobId ? await getDeletionJob(deps.db, jobId) : undefined;
    if (job?.status === "succeeded") {
      return { status: "completed", canCancel: false };
    }
    if (job?.status === "cancelled") {
      return { status: "cancelled", canCancel: false };
    }
    return { status: "none", canCancel: false };
  }

  const job = account.deletionJobId
    ? await getDeletionJob(deps.db, account.deletionJobId)
    : undefined;
  const scheduledIso = toIso(account.deletionScheduledAt);
  const canCancel =
    job?.status === "scheduled" &&
    scheduledIso !== undefined &&
    new Date(scheduledIso).getTime() > deps.clock.now().getTime();

  return {
    status: jobStatusToBody(job?.status),
    requestedAt: toIso(account.deletionRequestedAt),
    scheduledForDeletionAt: scheduledIso,
    cancelDeadline: scheduledIso,
    canCancel,
    jobStatus: job?.status,
  };
}

/**
 * API-006 POST /me/deletion-request。
 * 30日保留の削除ジョブを登録し、直ちに機能を制限する（FR-A11, BR-09）。
 */
export async function requestDeletion(
  deps: Deps,
  params: { uid: string; idempotencyKey: string; requestId: string },
): Promise<DeletionStatusBody> {
  const graceMs = deps.config.deletionGracePeriodDays * 24 * 3600_000;

  const committedAudits: AuditEventDoc[] = [];
  const { result, replayed } = await runIdempotent<DeletionStatusBody>(deps, {
    namespace: "deletion_request",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, {}),
    execute: async (tx) => {
      // Firestore の競合再試行で push が重複しないよう都度リセットする
      committedAudits.length = 0;
      const accountRef = deps.db.doc(`accounts/${params.uid}`);
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists) {
        throw ApiError.forbidden("アカウントが初期化されていません。");
      }
      const account = accountSnap.data() as AccountDoc;

      if (account.accountStatus === "pending_deletion") {
        // 二重申請は現在状態を返す（ジョブ多重登録しない）
        const existing = account.deletionJobId
          ? ((await tx.get(deps.db.doc(`deletionJobs/${account.deletionJobId}`))).data() as
              | DeletionJobDoc
              | undefined)
          : undefined;
        const scheduledIso = toIso(account.deletionScheduledAt);
        return {
          status: "pending_deletion",
          requestedAt: toIso(account.deletionRequestedAt),
          scheduledForDeletionAt: scheduledIso,
          cancelDeadline: scheduledIso,
          canCancel:
            scheduledIso !== undefined &&
            new Date(scheduledIso).getTime() > deps.clock.now().getTime(),
          jobStatus: existing?.status,
        };
      }
      if (
        account.accountStatus !== "active" &&
        account.accountStatus !== "onboarding_pending"
      ) {
        throw ApiError.forbidden("このアカウント状態では退会申請できません。");
      }

      const now = deps.clock.now();
      const requestedAt = Timestamp.fromDate(now);
      const scheduledAt = Timestamp.fromMillis(
        now.getTime() + graceMs,
      );
      const jobRef = deps.db.collection("deletionJobs").doc();
      const job: DeletionJobDoc = {
        subjectUid: params.uid,
        requestedAt,
        executeAfter: scheduledAt,
        status: "scheduled",
        steps: initialSteps(),
        attemptCount: 0,
        lastErrorCode: null,
      };
      tx.create(jobRef, job as unknown as DocumentData);

      tx.update(accountRef, {
        accountStatus: "pending_deletion",
        previousAccountStatus: account.accountStatus,
        deletionRequestedAt: requestedAt,
        deletionScheduledAt: scheduledAt,
        deletionJobId: jobRef.id,
        updatedAt: FieldValue.serverTimestamp(),
      });

      committedAudits.push(
        auditInTransaction(tx, deps, {
          actorType: "patient",
          actorUidHash: auditUidHash(deps, params.uid),
          action: AUDIT_ACTIONS.ACCOUNT_DELETION_REQUESTED,
          resourceType: "deletionJobs",
          resourceIdHash: auditResourceHash(deps, jobRef.id),
          requestId: params.requestId,
          outcome: "scheduled",
        }),
      );

      return {
        status: "pending_deletion" as const,
        requestedAt: requestedAt.toDate().toISOString(),
        scheduledForDeletionAt: scheduledAt.toDate().toISOString(),
        cancelDeadline: scheduledAt.toDate().toISOString(),
        canCancel: true,
        jobStatus: "scheduled" as const,
      };
    },
  });

  // コミット確定後にシンク転送用ログを出す（冪等リプレイでは execute が
  // 走らないため二重出力しない）
  for (const e of committedAudits) logAuditEvent(deps, e);

  // トークン失効はトランザクション外でベストエフォート実行。
  // 冪等リプレイ（応答喪失後の再送・取消後の再送）では、失効成功が
  // 記録済みの場合は新規セッションを失効させない。失効未記録なら再試行する。
  const revokeMarker = replayed
    ? (await getAccount(deps.db, params.uid))?.deletionTokensRevokedAt
    : undefined;
  if (revokeMarker == null) {
    try {
      await deps.authAdmin.revokeRefreshTokens(params.uid);
      await deps.db
        .doc(`accounts/${params.uid}`)
        .set(
          { deletionTokensRevokedAt: FieldValue.serverTimestamp() },
          { merge: true },
        )
        .catch((err) =>
          deps.logger.warn({ err }, "deletionTokensRevokedAt write failed"),
        );
    } catch (err) {
      deps.logger.warn(
        { err, uidHash: auditUidHash(deps, params.uid) },
        "revokeRefreshTokens failed",
      );
    }
  }

  return result;
}

/**
 * API-007 POST /me/deletion-request/cancel。本人のみ・期限内のみ取消可能。
 */
export async function cancelDeletion(
  deps: Deps,
  params: { uid: string; idempotencyKey: string; requestId: string },
): Promise<DeletionStatusBody> {
  const committedAudits: AuditEventDoc[] = [];
  const { result } = await runIdempotent<DeletionStatusBody>(deps, {
    namespace: "deletion_cancel",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, {}),
    execute: async (tx) => {
      // Firestore の競合再試行で push が重複しないよう都度リセットする
      committedAudits.length = 0;
      const accountRef = deps.db.doc(`accounts/${params.uid}`);
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists) {
        throw ApiError.forbidden("アカウントが初期化されていません。");
      }
      const account = accountSnap.data() as AccountDoc;
      if (account.accountStatus !== "pending_deletion" || !account.deletionJobId) {
        throw ApiError.precondition("取消対象の退会申請がありません。");
      }
      const scheduledIso = toIso(account.deletionScheduledAt);
      if (
        !scheduledIso ||
        new Date(scheduledIso).getTime() <= deps.clock.now().getTime()
      ) {
        throw ApiError.precondition("取消期限を過ぎています。");
      }

      const jobRef = deps.db.doc(`deletionJobs/${account.deletionJobId}`);
      const jobSnap = await tx.get(jobRef);
      if (!jobSnap.exists) {
        throw ApiError.precondition("削除ジョブが見つかりません。");
      }
      const job = jobSnap.data() as DeletionJobDoc;
      if (job.status !== "scheduled") {
        throw ApiError.precondition(
          "削除処理が開始されているため取消できません。",
        );
      }

      const restoredStatus =
        account.previousAccountStatus === "active" ||
        account.previousAccountStatus === "onboarding_pending"
          ? account.previousAccountStatus
          : "active";
      const ts = FieldValue.serverTimestamp();
      const del = FieldValue.delete();

      tx.update(accountRef, {
        accountStatus: restoredStatus,
        previousAccountStatus: del,
        deletionRequestedAt: del,
        deletionScheduledAt: del,
        deletionJobId: del,
        // 取消後も状態照会できるよう直近ジョブ参照を保持する
        lastDeletionJobId: jobRef.id,
        deletionTokensRevokedAt: del,
        updatedAt: ts,
      });
      tx.update(jobRef, { status: "cancelled", cancelledAt: ts });

      committedAudits.push(
        auditInTransaction(tx, deps, {
          actorType: "patient",
          actorUidHash: auditUidHash(deps, params.uid),
          action: AUDIT_ACTIONS.ACCOUNT_DELETION_CANCELLED,
          resourceType: "deletionJobs",
          resourceIdHash: auditResourceHash(deps, jobRef.id),
          requestId: params.requestId,
          outcome: "cancelled",
        }),
      );

      return {
        status: "cancelled" as const,
        canCancel: false,
        jobStatus: "cancelled" as const,
      };
    },
  });

  for (const e of committedAudits) logAuditEvent(deps, e);

  return result;
}
