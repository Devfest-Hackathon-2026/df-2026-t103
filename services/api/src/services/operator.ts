import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import { listAuditSummaries } from "../repos/auditSummaries.js";
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
    if (fac.syntheticDemo === true || fac.syntheticSelfService === true) {
      throw ApiError.forbidden("合成デモ施設を実施設として承認することはできません。");
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
      decision: "verified",
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
          recordRefHash: auditResourceHash(deps, params.verificationRecordId),
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
 * 既に運営停止済みなら冪等に成功し監査も発行しないが、施設自身による
 * 停止中は運営停止へ引き上げて監査する（引き上げないと施設側で再開可能なまま）。
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
    // 既停止で主体が施設でなければ（運営停止・未設定の旧データ）遷移なし。
    // 施設自身による停止は運営停止へ引き上げる
    // （引き上げないと施設側で再開でき、緊急停止が実効を失う）
    if (fac.receivingEnabled === false && fac.receivingDisabledBy !== "staff") {
      return;
    }
    const now = FieldValue.serverTimestamp();
    const escalating = fac.receivingEnabled === false;
    await tx.update(ref, {
      receivingEnabled: false,
      // 施設停止の引き上げは停止主体と理由を運営のものに置き換える。
      // 停止開始時刻（receivingDisabledAt）は実際に止まった時刻のまま保持する
      ...(escalating ? {} : { receivingDisabledAt: now }),
      receivingDisabledReason: params.reason,
      receivingDisabledBy: "platform",
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
        details: { from: escalating ? "staff_disabled" : "enabled" },
        ...(params.requestId ? { requestId: params.requestId } : {}),
      }),
    );
  });
  for (const e of committedAudits) logAuditEvent(deps, e);
  return { facilityId: params.facilityId, receivingEnabled: false };
}

/**
 * API-050 施設受付の再開（運営）。施設側で解除できない運営停止を戻す導線。
 * 既受付中は冪等に成功し、遷移がないため監査も発行しない。
 */
export async function enableFacilityReceiving(
  deps: Deps,
  params: {
    facilityId: string;
    operatorUid: string;
    requestId?: string;
  },
): Promise<{ facilityId: string; receivingEnabled: true }> {
  const committedAudits: AuditEventDoc[] = [];
  await deps.db.runTransaction(async (tx) => {
    committedAudits.length = 0;
    const ref = deps.db.doc(`facilities/${params.facilityId}`);
    const snap = await tx.get(ref);
    const fac = snap.data() as FacilityDoc | undefined;
    if (!snap.exists || !fac) {
      throw ApiError.notFound("施設が見つかりません。");
    }
    if (fac.receivingEnabled === true) return; // 既受付中: 遷移なし
    await tx.update(ref, {
      receivingEnabled: true,
      receivingDisabledAt: null,
      receivingDisabledReason: null,
      receivingDisabledBy: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    committedAudits.push(
      auditInTransaction(tx, deps, {
        actorType: "platform",
        actorUidHash: auditUidHash(deps, params.operatorUid),
        action: AUDIT_ACTIONS.FACILITY_RECEIVING_ENABLED,
        resourceType: "facility",
        resourceIdHash: auditResourceHash(deps, params.facilityId),
        outcome: "success",
        details: { from: "disabled" },
        ...(params.requestId ? { requestId: params.requestId } : {}),
      }),
    );
  });
  for (const e of committedAudits) logAuditEvent(deps, e);
  return { facilityId: params.facilityId, receivingEnabled: true };
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

/** O-002: privileged metadata-only audit monitoring; the read is itself audited. */
export async function listOperatorAuditEvents(
  deps: Deps,
  params: { operatorUid: string; limit: number; cursor?: string; requestId?: string },
) {
  const page = await listAuditSummaries(deps, params);
  await audit(deps, {
    actorType: "platform",
    actorUidHash: auditUidHash(deps, params.operatorUid),
    action: AUDIT_ACTIONS.AUDIT_EVENTS_LISTED,
    resourceType: "auditSummary",
    outcome: "success",
    ...(params.requestId ? { requestId: params.requestId } : {}),
  });
  return page;
}
