import type { DeletionJobDoc } from "../domain/firestoreDocs.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike, Timestamp } from "./helpers.js";

export function deletionJobRef(db: FirestoreLike, jobId: string) {
  return db.doc(`deletionJobs/${jobId}`);
}

export async function getDeletionJob(
  db: FirestoreLike,
  jobId: string,
): Promise<DeletionJobDoc | undefined> {
  const r = await getDoc<DeletionJobDoc>(db, `deletionJobs/${jobId}`);
  return r.data;
}

export async function findDueJobs(
  db: FirestoreLike,
  now: Timestamp,
  limit: number,
): Promise<Array<{ id: string; data: DeletionJobDoc }>> {
  const rows = await queryDocs<DeletionJobDoc>(
    db,
    "deletionJobs",
    [
      { field: "status", op: "==", value: "scheduled" },
      { field: "executeAfter", op: "<=", value: now },
    ],
    { orderBy: [{ field: "executeAfter", direction: "asc" }], limit },
  );
  return rows.map((r) => ({ id: r.id, data: r.data }));
}

/**
 * running のまま放置された（クレーム失効済み）ジョブを回収対象として列挙する。
 * findDueJobs は scheduled のみ返すため、ワーカー死亡時の復旧はこちらで拾う。
 */
export async function findAbandonedJobs(
  db: FirestoreLike,
  staleBefore: Timestamp,
  limit: number,
): Promise<Array<{ id: string; data: DeletionJobDoc }>> {
  const rows = await queryDocs<DeletionJobDoc>(
    db,
    "deletionJobs",
    [
      { field: "status", op: "==", value: "running" },
      { field: "lastStartedAt", op: "<=", value: staleBefore },
    ],
    { orderBy: [{ field: "lastStartedAt", direction: "asc" }], limit },
  );
  return rows.map((r) => ({ id: r.id, data: r.data }));
}

/**
 * 終端失敗したジョブを列挙する。failed は再実行されないが、
 * SLO-07 の期限超過アラート対象（未完了=未削除）として拾う。
 */
export async function findFailedJobs(
  db: FirestoreLike,
  limit: number,
): Promise<Array<{ id: string; data: DeletionJobDoc }>> {
  const rows = await queryDocs<DeletionJobDoc>(
    db,
    "deletionJobs",
    [{ field: "status", op: "==", value: "failed" }],
    { limit },
  );
  return rows.map((r) => ({ id: r.id, data: r.data }));
}

export async function findOpenJobForSubject(
  db: FirestoreLike,
  uid: string,
): Promise<{ id: string; data: DeletionJobDoc } | undefined> {
  const rows = await queryDocs<DeletionJobDoc>(
    db,
    "deletionJobs",
    [
      { field: "subjectUid", op: "==", value: uid },
      { field: "status", op: "in", value: ["scheduled", "running"] },
    ],
    { limit: 5 },
  );
  const first = rows[0];
  return first ? { id: first.id, data: first.data } : undefined;
}
