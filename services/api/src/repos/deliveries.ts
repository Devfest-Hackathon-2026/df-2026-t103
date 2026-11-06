import type { DeliveryDoc, FacilityDoc } from "../domain/firestoreDocs.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function deliveryRef(db: FirestoreLike, deliveryId: string) {
  return db.doc(`deliveries/${deliveryId}`);
}

export async function getDelivery(
  db: FirestoreLike,
  deliveryId: string,
): Promise<DeliveryDoc | undefined> {
  const r = await getDoc<DeliveryDoc>(db, `deliveries/${deliveryId}`);
  return r.data;
}

export async function getFacility(
  db: FirestoreLike,
  facilityId: string,
): Promise<FacilityDoc | undefined> {
  const r = await getDoc<FacilityDoc>(db, `facilities/${facilityId}`);
  return r.data;
}

export async function listDeliveriesBySender(
  db: FirestoreLike,
  senderUid: string,
  limit = 20,
): Promise<Array<{ id: string; data: DeliveryDoc }>> {
  return queryDocs<DeliveryDoc>(
    db,
    "deliveries",
    [{ field: "senderUid", op: "==", value: senderUid }],
    { orderBy: [{ field: "createdAt", direction: "desc" }], limit },
  );
}
