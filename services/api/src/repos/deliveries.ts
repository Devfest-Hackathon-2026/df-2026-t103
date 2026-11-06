import { FieldValue, Timestamp } from "firebase-admin/firestore";
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

export function deliveriesCollection(db: FirestoreLike) {
  return db.collection("deliveries");
}

export interface DeliveryListItem {
  id: string;
  facilityId: string;
  questionnaireId: string;
  questionnaireRevisionId: string;
  status: DeliveryDoc["status"];
  createdAt: unknown;
  deliveredAt: unknown;
  acknowledgedAt: unknown;
}

export interface DeliveryListResult {
  items: DeliveryListItem[];
  nextCursor: string | null;
}

/**
 * 施設の受信一覧（receivedAt=deliveredAt 降順、自院スコープ、20件カーソルページング）。
 * senderUid は一覧に含めない（03_機能仕様書 §3.8）。
 */
export async function listDeliveriesByFacility(
  db: FirestoreLike,
  facilityId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<DeliveryListResult> {
  const pageSize = opts?.limit ?? 20;
  const rows = await queryDocs<DeliveryDoc>(
    db,
    "deliveries",
    [{ field: "facilityId", op: "==", value: facilityId }],
    {
      orderBy: [
        { field: "deliveredAt", direction: "desc" },
        { field: "createdAt", direction: "desc" },
      ],
      limit: pageSize + 1,
    },
  );

  let items = rows;
  let nextCursor: string | null = null;
  if (rows.length > pageSize) {
    items = rows.slice(0, pageSize);
    nextCursor = items[items.length - 1]!.id;
  }

  return {
    items: items.map((r) => ({
      id: r.id,
      facilityId: r.data.facilityId,
      questionnaireId: r.data.questionnaireId,
      questionnaireRevisionId: r.data.questionnaireRevisionId,
      status: r.data.status,
      createdAt: r.data.createdAt,
      deliveredAt: r.data.deliveredAt ?? null,
      acknowledgedAt: r.data.acknowledgedAt ?? null,
    })),
    nextCursor,
  };
}

/** 配送詳細を取得する。見つからない場合は null。 */
export async function getDeliveryRecord(
  db: FirestoreLike,
  deliveryId: string,
): Promise<{ id: string; data: DeliveryDoc } | null> {
  const result = await getDoc<DeliveryDoc>(db, `deliveries/${deliveryId}`);
  if (!result.exists || !result.data) return null;
  return { id: deliveryId, data: result.data };
}

/**
 * 受領確認（acknowledged）。
 * 閲覧済み ≠ 診療予約（FR-H10）。status が already acknowledged の場合は冪等に返す。
 */
export async function acknowledgeDelivery(
  db: FirestoreLike,
  deliveryId: string,
  staffUid: string,
  now: Date,
): Promise<{ alreadyAcknowledged: boolean }> {
  let alreadyAcknowledged = false;
  await db.runTransaction(async (tx) => {
    const ref = deliveriesCollection(db).doc(deliveryId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() as DeliveryDoc;
    if (data.status === "acknowledged") {
      alreadyAcknowledged = true;
      return;
    }
    tx.update(ref, {
      status: "acknowledged",
      acknowledgedAt: Timestamp.fromDate(now),
      receivedByStaffUid: staffUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { alreadyAcknowledged };
}
