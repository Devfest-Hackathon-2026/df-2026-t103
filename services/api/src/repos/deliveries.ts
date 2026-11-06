import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
} from "firebase-admin/firestore";
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

  // カーソルは直前ページ末尾の deliveryId。そのスナップショットで startAfter し、
  // ソート値が同一のドキュメント間でも一意に分割できるようにする。
  // 失効・他院のカーソルは空ページを返し、ページネーションを安全に打ち切る。
  let startAfterDoc: DocumentSnapshot | undefined;
  if (opts?.cursor) {
    const curSnap = await db.doc(`deliveries/${opts.cursor}`).get();
    const cur = curSnap.data() as DeliveryDoc | undefined;
    if (
      !curSnap.exists ||
      !cur ||
      cur.facilityId !== facilityId ||
      cur.deliveredAt == null ||
      cur.createdAt == null
    ) {
      return { items: [], nextCursor: null };
    }
    startAfterDoc = curSnap;
  }

  const rows = await queryDocs<DeliveryDoc>(
    db,
    "deliveries",
    [{ field: "facilityId", op: "==", value: facilityId }],
    {
      orderBy: [
        { field: "deliveredAt", direction: "desc" },
        { field: "createdAt", direction: "desc" },
      ],
      ...(startAfterDoc ? { startAfterDoc } : {}),
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
): Promise<{
  found: boolean;
  alreadyAcknowledged: boolean;
  /** failed/revoked の終端状態では受領確認できない。 */
  terminal: boolean;
  acknowledgedAt: unknown;
}> {
  let found = false;
  let alreadyAcknowledged = false;
  let terminal = false;
  let acknowledgedAt: unknown = null;
  await db.runTransaction(async (tx) => {
    // tx リトライ時に前試行の結果が残らないよう各試行でリセット
    found = false;
    alreadyAcknowledged = false;
    terminal = false;
    acknowledgedAt = null;
    const ref = deliveriesCollection(db).doc(deliveryId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    found = true;
    const data = snap.data() as DeliveryDoc;
    if (data.status === "acknowledged") {
      alreadyAcknowledged = true;
      acknowledgedAt = data.acknowledgedAt ?? null;
      return;
    }
    if (data.status === "failed" || data.status === "revoked") {
      // 終端状態への受領確認は状態機械違反（02 §9）
      terminal = true;
      return;
    }
    acknowledgedAt = Timestamp.fromDate(now);
    tx.update(ref, {
      status: "acknowledged",
      acknowledgedAt,
      receivedByStaffUid: staffUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { found, alreadyAcknowledged, terminal, acknowledgedAt };
}
