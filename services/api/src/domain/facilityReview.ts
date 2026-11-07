export const REVIEW_STATUSES = ["pending", "verified", "rejected", "suspended"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export interface ReviewChecks {
  existence: boolean;
  applicant: boolean;
  receiverContact: boolean;
  location: boolean;
}
export interface ReviewFacility {
  facilityId: string;
  legalName: string;
  displayName: string;
  verificationStatus: ReviewStatus;
  receivingEnabled: boolean;
  createdAt: string | null;
}
export interface VerificationSummary {
  recordId: string;
  decision: "verified" | "rejected";
  checks: ReviewChecks;
  createdAt: string | null;
}
