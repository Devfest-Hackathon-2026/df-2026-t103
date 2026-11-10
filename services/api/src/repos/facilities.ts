import type { MembershipRole } from "../domain/types.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export interface ActiveMembership {
  id: string;
  facilityId: string;
  role: MembershipRole;
}

export interface FacilityDoc {
  facilityId: string;
  legalName: string;
  displayName: string;
  placeId?: string;
  address: { formatted?: string };
  verificationStatus: "pending" | "verified" | "rejected" | "suspended";
  receivingEnabled: boolean;
  syntheticDemo?: boolean;
  syntheticSelfService?: boolean;
  syntheticPatientUid?: string;
}

/** Server-owned markers must both match; never accept these from a client. */
export function isSyntheticRecipient(facility: { verificationStatus: string; syntheticDemo?: boolean; syntheticPatientUid?: string }, uid: string, facilityId: string, patient: unknown): boolean {
  return facility.verificationStatus === "pending" && facility.syntheticDemo === true && facility.syntheticPatientUid === uid &&
    typeof patient === "object" && patient !== null && "facilityId" in patient && patient.facilityId === facilityId;
}

/** facilityId で施設を取得する。存在しなければ null。 */
export async function getFacilityById(
  db: FirestoreLike,
  facilityId: string,
): Promise<FacilityDoc | null> {
  const { exists, data } = await getDoc<FacilityDoc>(db, `facilities/${facilityId}`);
  if (!exists || !data) return null;
  return data;
}

/** placeId リストに対応する参加施設を一括検索する。 */
export async function getFacilitiesByPlaceIds(
  db: FirestoreLike,
  placeIds: string[],
): Promise<FacilityDoc[]> {
  if (placeIds.length === 0) return [];
  const rows = await queryDocs<FacilityDoc>(db, "facilities", [
    { field: "placeId", op: "in", value: placeIds },
  ]);
  return rows.map((r) => r.data);
}

/** Custom Claims ではなく facilityMemberships 正本から有効所属を解決する（02 §5.3）。 */
export async function getActiveMemberships(
  db: FirestoreLike,
  uid: string,
): Promise<ActiveMembership[]> {
  const rows = await queryDocs<{
    facilityId: string;
    role: MembershipRole;
  }>(
    db,
    "facilityMemberships",
    [
      { field: "userUid", op: "==", value: uid },
      { field: "status", op: "==", value: "active" },
    ],
    { limit: 50 },
  );
  return rows.map((r) => ({ id: r.id, facilityId: r.data.facilityId, role: r.data.role }));
}
