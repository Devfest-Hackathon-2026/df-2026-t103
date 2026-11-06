import type { MembershipRole } from "../domain/types.js";
import { queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export interface ActiveMembership {
  id: string;
  facilityId: string;
  role: MembershipRole;
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
