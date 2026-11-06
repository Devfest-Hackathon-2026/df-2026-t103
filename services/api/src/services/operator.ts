import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import {
  audit,
  auditInTransaction,
  auditResourceHash,
  auditUidHash,
  logAuditEvent,
} from "../lib/audit.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import type { AuditEventDoc, FacilityDoc } from "../domain/firestoreDocs.js";
import {
  listFailedDeletionJobs,
  listFailedOcrJobs,
  type JobFailurePage,
} from "../repos/jobFailures.js";

/**
 * API-036 施設本人確認承認（FR-H04, O-001）。
 * 4検証項目（実在・申請者・受信担当者・所在地）の証跡を
 * facilityVerificationRecords に残し、verificationStatus を verified にする。
 * 既承認は 409。未承認施設への送信可否は deliveries 側の
 * verificationStatus==="verified" ゲートが継続して保証する。
 */
export async function verifyFacility(
  deps: Deps,
  params: {
    facilityId: string;
    operatorUid: string;
    checks: {
      existence: boolean;
      applicant: boolean;
      receiverContact: boolean;
      location: boolean;
    };
    verificationRecordId: string;
    note?: string;
    requestId?: string;
  },
): Promise<{ facilityId: string; verificationStatus: "verified"; verifiedAt: string }> {
  const c = params.checks;
  if (!(c.existence && c.applicant && c.receiverContact && c.location)) {
    throw ApiError.validation(
      [{ field: "checks", message: "all four verification checks must be true" }],
      "承認には4検証項目（実在・申請者・受信担当者・所在地）が全て必要です。",
    );
  }
  const now = deps.clock.now();
  const committedAudits: AuditEventDoc[] = [];
  await deps.db.runTransaction(async (tx) => {
    // tx リトライ時にロールバック済みイベントが残らないよう各試行でリセット
    committedAudits.length = 0;
    const ref = deps.db.doc(`facilities/${params.facilityId}`);
    const snap = await tx.get(ref);
    const fac = snap.data() as FacilityDoc | undefined;
    if (!snap.exists || !fac) {
      throw ApiError.notFound("施設が見つかりません。");
    }
    if (fac.verificationStatus === "verified") {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "この施設は既に承認済みです。",
      );
    }
    const verifiedAt = Timestamp.fromDate(now);
    await tx.update(ref, {
      verificationStatus: "verified",
      verifiedAt,
      verificationRecordId: params.verificationRecordId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const recRef = deps.db.collection("facilityVerificationRecords").doc();
    await tx.create(recRef, {
      facilityId: params.facilityId,
      verifierUid: params.operatorUid,
      checks: params.checks,
      verificationRecordId: params.verificationRecordId,
      note: params.note ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
    committedAudits.push(
      auditInTransaction(tx, deps, {
        actorType: "platform",
        actorUidHash: auditUidHash(deps, params.operatorUid),
        action: AUDIT_ACTIONS.FACILITY_VERIFIED,
        resourceType: "facility",
        resourceIdHash: auditResourceHash(deps, params.facilityId),
        outcome: "success",
        details: {
          from: fac.verificationStatus,
          recordId: params.verificationRecordId,
        },
        ...(params.requestId ? { requestId: params.requestId } : {}),
      }),
    );
  });
  for (const e of committedAudits) logAuditEvent(deps, e);
  return {
    facilityId: params.facilityId,
    verificationStatus: "verified",
    verifiedAt: now.toISOString(),
  };
}

/**
 * API-037 施設受付の緊急停止（O-002 緊急対応手順）。
 * receivingEnabled を false にする。審査状態自体は変更しない
 * （verificationStatus は真正性、receivingEnabled は運用キルスイッチ）。
 * 既停止は冪等に成功し、遷移がないため監査も発行しない。
 */
export async function disableFacilityReceiving(
  deps: Deps,
  params: {
    facilityId: string;
    operatorUid: string;
    reason: string;
    requestId?: string;
  },
): Promise<{ facilityId: string; receivingEnabled: false }> {
  const committedAudits: AuditEventDoc[] = [];
  await deps.db.runTransaction(async (tx) => {
    committedAudits.length = 0;
    const ref = deps.db.doc(`facilities/${params.facilityId}`);
    const snap = await tx.get(ref);
    const fac = snap.data() as FacilityDoc | undefined;
    if (!snap.exists || !fac) {
      throw ApiError.notFound("施設が見つかりません。");
    }
    if (fac.receivingEnabled === false) return; // 既停止: 遷移なし
    const now = FieldValue.serverTimestamp();
    await tx.update(ref, {
      receivingEnabled: false,
      receivingDisabledAt: now,
      receivingDisabledReason: params.reason,
      updatedAt: now,
    });
    committedAudits.push(
      auditInTransaction(tx, deps, {
        actorType: "platform",
        actorUidHash: auditUidHash(deps, params.operatorUid),
        action: AUDIT_ACTIONS.FACILITY_RECEIVING_DISABLED,
        resourceType: "facility",
        resourceIdHash: auditResourceHash(deps, params.facilityId),
        outcome: "success",
        details: { from: "enabled" },
        ...(params.requestId ? { requestId: params.requestId } : {}),
      }),
    );
  });
  for (const e of committedAudits) logAuditEvent(deps, e);
  return { facilityId: params.facilityId, receivingEnabled: false };
}

/**
 * API-038 失敗ジョブ一覧（FR-O04: PII原則非表示）。
 * 一覧は type/jobId/失敗分類/時刻のみで、患者UID・件名UID等は返さない。
 */
export async function listJobFailures(
  deps: Deps,
  params: {
    type: "ocr" | "deletion";
    operatorUid: string;
    cursor?: string;
    limit: number;
    requestId?: string;
  },
): Promise<JobFailurePage> {
  const page =
    params.type === "ocr"
      ? await listFailedOcrJobs(deps, {
          ...(params.cursor ? { cursor: params.cursor } : {}),
          limit: params.limit,
        })
      : await listFailedDeletionJobs(deps, {
          ...(params.cursor ? { cursor: params.cursor } : {}),
          limit: params.limit,
        });
  await audit(deps, {
    actorType: "platform",
    actorUidHash: auditUidHash(deps, params.operatorUid),
    action: AUDIT_ACTIONS.JOB_FAILURES_LISTED,
    resourceType: "jobFailures",
    resourceIdHash: auditResourceHash(deps, params.type),
    outcome: "success",
    details: { type: params.type },
    ...(params.requestId ? { requestId: params.requestId } : {}),
  });
  return page;
}
