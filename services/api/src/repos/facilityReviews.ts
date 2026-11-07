import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import { REVIEW_STATUSES, type ReviewFacility, type ReviewStatus, type VerificationSummary } from "../domain/facilityReview.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../lib/opaqueCursor.js";
import { hmacSha256Hex } from "../lib/hash.js";
import { ApiError } from "../lib/errors.js";
import { queryDocs, type QueryCondition } from "./helpers.js";

function iso(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("toDate" in value) || typeof value.toDate !== "function") return null;
  const date: unknown = value.toDate();
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function pageRows(deps: Deps, collection: string, opts: { limit: number; cursor?: string }, conditions: QueryCondition[] = [], facilityId?: string) {
  let startAfterDoc: DocumentSnapshot | undefined;
  if (opts.cursor) {
    const path = decodeOpaqueCursor(deps.config.hmacSecret, opts.cursor);
    if (!path || !new RegExp(`^${collection}/[^/]+$`).test(path)) return { rows: [], nextCursor: null };
    const snap = await deps.db.doc(path).get();
    const data = snap.data();
    if (!snap.exists || data?.["createdAt"] == null || (facilityId && data["facilityId"] !== facilityId)) return { rows: [], nextCursor: null };
    startAfterDoc = snap;
  }
  const rows = await queryDocs<Record<string, unknown>>(deps.db, collection, conditions, {
    orderBy: [{ field: "createdAt", direction: "desc" }],
    ...(startAfterDoc ? { startAfterDoc } : {}), limit: opts.limit + 1,
  });
  return {
    rows: rows.slice(0, opts.limit),
    nextCursor: rows.length > opts.limit ? encodeOpaqueCursor(deps.config.hmacSecret, rows[opts.limit - 1]!.path) : null,
  };
}

export async function listReviewFacilities(deps: Deps, opts: { limit: number; cursor?: string }) {
  const { rows, nextCursor } = await pageRows(deps, "facilities", opts);
  const items = rows.map(({ id, data }): ReviewFacility => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || typeof data["legalName"] !== "string" || typeof data["displayName"] !== "string" || !REVIEW_STATUSES.includes(data["verificationStatus"] as ReviewStatus) || typeof data["receivingEnabled"] !== "boolean") throw new ApiError(500, "INTERNAL", "施設データの形式が不正です。");
    return {
      facilityId: id, legalName: data["legalName"], displayName: data["displayName"],
      verificationStatus: data["verificationStatus"] as ReviewStatus,
      receivingEnabled: data["receivingEnabled"], createdAt: iso(data["createdAt"]),
    };
  });
  return { items, nextCursor };
}

export async function listVerificationSummaries(deps: Deps, facilityId: string, opts: { limit: number; cursor?: string }) {
  if (!(await deps.db.doc(`facilities/${facilityId}`).get()).exists) throw ApiError.notFound();
  const { rows, nextCursor } = await pageRows(deps, "facilityVerificationRecords", opts, [{ field: "facilityId", op: "==", value: facilityId }], facilityId);
  const items = rows.map(({ id, data }): VerificationSummary => {
    const checks = data["checks"] as Record<string, unknown> | undefined;
    if (!checks || ["existence", "applicant", "receiverContact", "location"].some((key) => typeof checks[key] !== "boolean") || (data["decision"] != null && data["decision"] !== "verified" && data["decision"] !== "rejected")) throw new ApiError(500, "INTERNAL", "検証証跡の形式が不正です。");
    if (data["decision"] == null && ["existence", "applicant", "receiverContact", "location"].some((key) => checks[key] !== true)) throw new ApiError(500, "INTERNAL", "旧承認証跡の形式が不正です。");
    return {
      recordId: `vr_${hmacSha256Hex(deps.config.hmacSecret, `verification-summary:${id}`)}`,
      // Older records were created by the approval-only API.
      decision: data["decision"] === "rejected" ? "rejected" : "verified",
      checks: { existence: checks["existence"] as boolean, applicant: checks["applicant"] as boolean, receiverContact: checks["receiverContact"] as boolean, location: checks["location"] as boolean },
      createdAt: iso(data["createdAt"]),
    };
  });
  return { items, nextCursor };
}
