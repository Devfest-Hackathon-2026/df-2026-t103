/** GET /v1/me/facility-memberships の応答型（API契約と一致させる）。 */
export type StaffRole = "facility_staff" | "facility_clinician" | "facility_admin";

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  facility_admin: "施設管理者",
  facility_clinician: "診療担当",
  facility_staff: "受付担当",
};

export interface FacilitySummary {
  displayName: string;
  addressFormatted: string | null;
  verificationStatus: "pending" | "verified" | "rejected" | "suspended";
  receivingEnabled: boolean;
}

export interface StaffMembership {
  membershipId: string;
  facilityId: string;
  role: StaffRole;
  facility: FacilitySummary | null;
}

export interface MembershipsResponse {
  items: StaffMembership[];
}
