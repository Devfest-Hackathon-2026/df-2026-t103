import type { UploadDoc } from "../domain/firestoreDocs.js";
import type { UploadStatus } from "../domain/types.js";
import { getDoc, queryDocs } from "./helpers.js";
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

/** 患者の有効（pending/uploaded）アップロード数。枚数上限の事前チェック用。 */
export async function countActiveUploads(
  db: FirestoreLike,
  patientUid: string,
): Promise<number> {
  const rows = await queryDocs<UploadDoc>(db, "uploads", [
    { field: "patientUid", op: "==", value: patientUid },
    { field: "status", op: "in", value: ["pending", "uploaded"] as UploadStatus[] },
  ]);
  return rows.length;
}
