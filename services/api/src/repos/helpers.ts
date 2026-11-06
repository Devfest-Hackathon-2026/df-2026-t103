import type {
  Firestore,
  DocumentData,
  DocumentReference,
  Transaction,
  Timestamp,
  Query,
  WhereFilterOp,
} from "firebase-admin/firestore";

export type { DocumentData, Transaction, Timestamp };

/** Admin SDK のうち本サービスが使うサブセット。テストではインメモリ実装を注入する。 */
export type FirestoreLike = Pick<
  Firestore,
  "doc" | "collection" | "collectionGroup" | "runTransaction" | "batch"
>;

const DELETE_BATCH = 400;

export async function getDoc<T>(
  db: FirestoreLike,
  path: string,
): Promise<{ exists: boolean; data: T | undefined; ref: DocumentReference }> {
  const ref = db.doc(path);
  const snap = await ref.get();
  return { exists: snap.exists, data: snap.data() as T | undefined, ref };
}

export interface QueryCondition {
  field: string;
  op: WhereFilterOp;
  value: unknown;
}

export async function queryDocs<T>(
  db: FirestoreLike,
  collectionPath: string,
  conditions: QueryCondition[],
  options?: {
    orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>;
    limit?: number;
    collectionGroup?: boolean;
  },
): Promise<Array<{ id: string; path: string; data: T }>> {
  let q: Query = options?.collectionGroup
    ? db.collectionGroup(collectionPath)
    : db.collection(collectionPath);
  for (const c of conditions) q = q.where(c.field, c.op, c.value);
  for (const o of options?.orderBy ?? []) {
    q = q.orderBy(o.field, o.direction ?? "asc");
  }
  if (options?.limit) q = q.limit(options.limit);
  const snap = await q.get();
  return snap.docs.map((d) => ({
    id: d.id,
    path: d.ref.path,
    data: d.data() as T,
  }));
}

/** 条件一致ドキュメントをページングしながら全削除する。削除件数を返す。 */
export async function deleteWhere(
  db: FirestoreLike,
  collectionPath: string,
  conditions: QueryCondition[],
  options?: { collectionGroup?: boolean; pageSize?: number },
): Promise<number> {
  const pageSize = options?.pageSize ?? DELETE_BATCH;
  let total = 0;
  for (;;) {
    let q: Query = options?.collectionGroup
      ? db.collectionGroup(collectionPath)
      : db.collection(collectionPath);
    for (const c of conditions) q = q.where(c.field, c.op, c.value);
    const snap = await q.limit(pageSize).get();
    if (snap.empty) return total;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    total += snap.size;
    if (snap.size < pageSize) return total;
  }
}

/** ドキュメント配下のサブコレクションを再帰的に削除した後、本体を削除する。 */
export async function deleteRecursive(
  db: FirestoreLike,
  docPath: string,
): Promise<void> {
  const ref = db.doc(docPath);
  const subs = await ref.listCollections();
  for (const sub of subs) {
    for (;;) {
      const snap = await sub.limit(DELETE_BATCH).get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        await deleteRecursive(db, d.ref.path);
      }
      if (snap.size < DELETE_BATCH) break;
    }
  }
  await ref.delete();
}

/** サブコレクション内で条件一致するドキュメントが1件でも残存するか。 */
export async function existsWhere(
  db: FirestoreLike,
  collectionPath: string,
  conditions: QueryCondition[],
  options?: { collectionGroup?: boolean },
): Promise<boolean> {
  let q: Query = options?.collectionGroup
    ? db.collectionGroup(collectionPath)
    : db.collection(collectionPath);
  for (const c of conditions) q = q.where(c.field, c.op, c.value);
  const snap = await q.limit(1).get();
  return !snap.empty;
}
