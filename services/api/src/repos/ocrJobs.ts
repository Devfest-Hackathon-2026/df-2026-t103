import type { OcrJobDoc } from "../domain/firestoreDocs.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function ocrJobRef(db: FirestoreLike, jobId: string) {
  return db.doc(`ocrJobs/${jobId}`);
}

export async function getOcrJob(
  db: FirestoreLike,
  jobId: string,
): Promise<OcrJobDoc | undefined> {
  const r = await getDoc<OcrJobDoc>(db, `ocrJobs/${jobId}`);
  return r.data;
}

/** 同一 upload の最新ジョブ（再処理時は複数存在し得る）。 */
export async function latestOcrJobForUpload(
  db: FirestoreLike,
  uploadId: string,
): Promise<{ id: string; data: OcrJobDoc } | undefined> {
  const rows = await queryDocs<OcrJobDoc>(db, "ocrJobs", [
    { field: "uploadId", op: "==", value: uploadId },
  ], {
    orderBy: [{ field: "createdAt", direction: "desc" }],
    limit: 1,
  });
  return rows[0];
}
