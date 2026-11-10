import type { MedicationDoc } from "../domain/firestoreDocs.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function medicationRef(db: FirestoreLike, medicationId: string) {
  return db.doc(`medications/${medicationId}`);
}

export async function getMedication(
  db: FirestoreLike,
  medicationId: string,
): Promise<MedicationDoc | undefined> {
  const r = await getDoc<MedicationDoc>(db, `medications/${medicationId}`);
  return r.data;
}

/** 患者の薬剤一覧（FR-M05: 現在/過去/不明を区別して全件返す）。 */
export async function listMedications(
  db: FirestoreLike,
  patientUid: string,
): Promise<Array<{ id: string; data: MedicationDoc }>> {
  return queryDocs<MedicationDoc>(db, "medications", [
    { field: "patientUid", op: "==", value: patientUid },
  ], {
    orderBy: [{ field: "updatedAt", direction: "desc" }],
  });
}

/** FR-M07: 問診票へ添付対象としてマークされた薬剤のみ。 */
export async function listAttachableMedications(
  db: FirestoreLike,
  patientUid: string,
): Promise<Array<{ id: string; data: MedicationDoc }>> {
  const rows = await listMedications(db, patientUid);
  return rows.filter((r) => r.data.attachToQuestionnaire === true);
}
