export type ReviewStatus = "pending" | "verified" | "rejected" | "suspended";
export type ReviewChecks = { existence: boolean; applicant: boolean; receiverContact: boolean; location: boolean };
export type ReviewFacility = { facilityId: string; legalName: string; displayName: string; verificationStatus: ReviewStatus; receivingEnabled: boolean; createdAt: string | null };
export type VerificationSummary = { recordId: string; decision: "verified" | "rejected"; checks: ReviewChecks; createdAt: string | null };
export type Page<T> = { items: T[]; nextCursor: string | null };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("API応答の形式が不正です。");
  return value as Record<string, unknown>;
}
function validDate(value: unknown): value is string | null {
  return value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
}
function parsePage<T>(value: unknown, parse: (raw: unknown) => T): Page<T> {
  const page = record(value);
  if (!Array.isArray(page.items) || page.items.length > 100 || !(page.nextCursor === null || typeof page.nextCursor === "string" && /^[A-Za-z0-9_-]{1,2100}$/.test(page.nextCursor))) throw new Error("API応答の形式が不正です。");
  return { items: page.items.map(parse), nextCursor: page.nextCursor };
}
export function parseReviewFacilities(value: unknown) {
  return parsePage<ReviewFacility>(value, (raw) => {
    const item = record(raw);
    if (typeof item.facilityId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(item.facilityId) || typeof item.legalName !== "string" || typeof item.displayName !== "string" || !["pending", "verified", "rejected", "suspended"].includes(String(item.verificationStatus)) || typeof item.receivingEnabled !== "boolean" || !validDate(item.createdAt)) throw new Error("施設一覧の形式が不正です。");
    return { facilityId: item.facilityId, legalName: item.legalName, displayName: item.displayName, verificationStatus: item.verificationStatus as ReviewStatus, receivingEnabled: item.receivingEnabled, createdAt: item.createdAt };
  });
}
export function parseVerificationSummaries(value: unknown) {
  return parsePage<VerificationSummary>(value, (raw) => {
    const item = record(raw);
    const checks = record(item.checks);
    if (typeof item.recordId !== "string" || !/^vr_[0-9a-f]{64}$/.test(item.recordId) || !(item.decision === "verified" || item.decision === "rejected") || !validDate(item.createdAt) || ["existence", "applicant", "receiverContact", "location"].some((key) => typeof checks[key] !== "boolean")) throw new Error("検証証跡の形式が不正です。");
    return { recordId: item.recordId, decision: item.decision, createdAt: item.createdAt, checks: { existence: checks.existence as boolean, applicant: checks.applicant as boolean, receiverContact: checks.receiverContact as boolean, location: checks.location as boolean } };
  });
}
