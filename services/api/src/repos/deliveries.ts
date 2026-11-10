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
  patientDisplayName: string | null;
  createdAt: unknown;
  deliveredAt: unknown;
  acknowledgedAt: unknown;
}

export interface DeliveryListResult {
  items: DeliveryListItem[];
  nextCursor: string | null;
}

/** Firestore SDK がカーソル位置エラーで投げる INVALID_ARGUMENT を検知する。 */
function isCursorArgumentError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 3 || code === "invalid-argument") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /INVALID_ARGUMENT|invalid argument|cursor position is outside/i.test(message);
}

/**
 * 施設の受信一覧（receivedAt=deliveredAt 降順、自院スコープ、20件カーソルページング）。
 * senderUid は一覧に含めない（03_機能仕様書 §3.8）。
 * 絞り込み・検索はサーバ側のみで行い、全件をクライアントへ送らない（H-003 検索制限）。
 */
export async function listDeliveriesByFacility(
  db: FirestoreLike,
  facilityId: string,
  opts?: {
    cursor?: string;
    limit?: number;
    status?: DeliveryDoc["status"];
    /** 患者表示名の前方一致（自院スコープ内のみ） */
    q?: string;
  },
): Promise<DeliveryListResult> {
  const pageSize = opts?.limit ?? 20;
  const q = opts?.q && opts.q.length > 0 ? opts.q : null;

  // カーソルは直前ページ末尾の deliveryId。そのスナップショットで startAfter し、
  // ソート値が同一のドキュメント間でも一意に分割できるようにする。
  // 失効・他院のカーソルは空ページを返し、ページネーションを安全に打ち切る。
  // 名前検索中はソート先頭が patientDisplayName のため、カーソル doc が
  // 表示名を持ち現在の前方一致範囲内であることも検証する
  // （範囲外・欠損カーソルは実 Firestore で INVALID_ARGUMENT=500 になる）。
  let startAfterDoc: DocumentSnapshot | undefined;
  if (opts?.cursor) {
    const curSnap = await db.doc(`deliveries/${opts.cursor}`).get();
    const cur = curSnap.data() as DeliveryDoc | undefined;
    const cursorName = cur?.patientDisplayName;
    if (
      !curSnap.exists ||
      !cur ||
      cur.facilityId !== facilityId ||
      cur.deliveredAt == null ||
      cur.createdAt == null ||
      (q !== null &&
        (typeof cursorName !== "string" || cursorName < q || cursorName >= `${q}ﾀ`))
    ) {
      return { items: [], nextCursor: null };
    }
    startAfterDoc = curSnap;
  }

  const filters: Array<{ field: string; op: "==" | ">=" | "<=" | "<"; value: unknown }> = [
    { field: "facilityId", op: "==", value: facilityId },
  ];
  if (opts?.status) filters.push({ field: "status", op: "==", value: opts.status });

  // 名前検索は表示名の範囲クエリ（前方一致）で、順序は deliveredAt から
  // patientDisplayName へ切り替える（別複合索引）。
  const orderBy = q
    ? [
        { field: "patientDisplayName", direction: "asc" as const },
        { field: "deliveredAt", direction: "desc" as const },
      ]
    : [
        { field: "deliveredAt", direction: "desc" as const },
        { field: "createdAt", direction: "desc" as const },
      ];
  if (q) {
    filters.push(
      { field: "patientDisplayName", op: ">=", value: q },
      { field: "patientDisplayName", op: "<", value: `${q}\uf8ff` },
    );
  }

  // 上記で検証済みでも索引未適用・SDK差異によるカーソル範囲エラーは
  // 500 ではなく安全な空ページに落とす
  let rows;
  try {
    rows = await queryDocs<DeliveryDoc>(
      db,
      "deliveries",
      filters,
      {
        orderBy,
        ...(startAfterDoc ? { startAfterDoc } : {}),
        limit: pageSize + 1,
      },
    );
  } catch (error) {
    if (isCursorArgumentError(error)) return { items: [], nextCursor: null };
    throw error;
  }

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
      patientDisplayName: r.data.patientDisplayName ?? null,
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
