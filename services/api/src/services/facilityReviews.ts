import { FieldValue } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { ReviewChecks } from "../domain/facilityReview.js";
import type { AuditEventDoc, FacilityDoc } from "../domain/firestoreDocs.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { audit, auditInTransaction, auditResourceHash, auditUidHash, logAuditEvent } from "../lib/audit.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { listReviewFacilities, listVerificationSummaries } from "../repos/facilityReviews.js";

export async function listOperatorFacilities(deps: Deps, params: { operatorUid: string; limit: number; cursor?: string; requestId: string }) {
  const result = await listReviewFacilities(deps, params);
  await audit(deps, { actorType: "platform", actorUidHash: auditUidHash(deps, params.operatorUid), action: AUDIT_ACTIONS.FACILITY_REVIEWS_LISTED, outcome: "success", requestId: params.requestId });
  return result;
}

export async function listOperatorVerificationRecords(deps: Deps, params: { facilityId: string; operatorUid: string; limit: number; cursor?: string; requestId: string }) {
  const result = await listVerificationSummaries(deps, params.facilityId, params);
  await audit(deps, { actorType: "platform", actorUidHash: auditUidHash(deps, params.operatorUid), action: AUDIT_ACTIONS.FACILITY_VERIFICATION_RECORDS_LISTED, resourceIdHash: auditResourceHash(deps, params.facilityId), outcome: "success", requestId: params.requestId });
  return result;
}

/** Only pending applications can be rejected. Already-rejected requests are no-ops. */
export async function rejectFacility(deps: Deps, params: { facilityId: string; operatorUid: string; checks: ReviewChecks; verificationRecordId: string; reason: string; requestId: string }) {
  const committed: AuditEventDoc[] = [];
  await deps.db.runTransaction(async (tx) => {
    committed.length = 0;
    const ref = deps.db.doc(`facilities/${params.facilityId}`);
    const snap = await tx.get(ref);
    const facility = snap.data() as FacilityDoc | undefined;
    if (!snap.exists || !facility) throw ApiError.notFound();
    if (facility.verificationStatus === "rejected") return;
    if (facility.verificationStatus !== "pending") throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "審査状態が変わっています。一覧を再取得してください。");
    await tx.update(ref, { verificationStatus: "rejected", receivingEnabled: false, verificationRecordId: params.verificationRecordId, updatedAt: FieldValue.serverTimestamp() });
    await tx.create(deps.db.collection("facilityVerificationRecords").doc(), {
      facilityId: params.facilityId, verifierUid: params.operatorUid,
      decision: "rejected", checks: params.checks, verificationRecordId: params.verificationRecordId,
      note: params.reason, createdAt: FieldValue.serverTimestamp(),
    });
    committed.push(auditInTransaction(tx, deps, { actorType: "platform", actorUidHash: auditUidHash(deps, params.operatorUid), action: AUDIT_ACTIONS.FACILITY_REJECTED, resourceType: "facility", resourceIdHash: auditResourceHash(deps, params.facilityId), outcome: "success", details: { from: "pending" }, requestId: params.requestId }));
  });
  for (const event of committed) logAuditEvent(deps, event);
  return { facilityId: params.facilityId, verificationStatus: "rejected" as const };
}
