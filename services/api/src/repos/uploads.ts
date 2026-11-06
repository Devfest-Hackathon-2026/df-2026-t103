import type { Timestamp } from "firebase-admin/firestore";
import type { UploadDoc } from "../domain/firestoreDocs.js";
import type { UploadStatus } from "../domain/types.js";
import { getDoc } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function uploadRef(db: FirestoreLike, uploadId: string) {
  return db.doc(`uploads/${uploadId}`);
}

export async function getUpload(
  db: FirestoreLike,
  uploadId: string,
): Promise<UploadDoc | undefined> {
  const r = await getDoc<UploadDoc>(db, `uploads/${uploadId}`);
  return r.data;
}

/**
 * 枚数上限カウント用クエリ（新規作成時のtx内で tx.get() する）。
 * 期限切れドキュメントは容量を消費しないよう expiresAt で除外する。
 */
export function activeUploadsQuery(
  db: FirestoreLike,
  patientUid: string,
  now: Timestamp,
) {
  return db
    .collection("uploads")
    .where("patientUid", "==", patientUid)
    .where("status", "in", ["pending", "uploaded"] as UploadStatus[])
    .where("expiresAt", ">", now);
}
