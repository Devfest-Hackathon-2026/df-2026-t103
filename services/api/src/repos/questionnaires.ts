import type {
  QuestionnaireDoc,
  QuestionnaireRevisionDoc,
} from "../domain/firestoreDocs.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function questionnaireRef(db: FirestoreLike, questionnaireId: string) {
  return db.doc(`questionnaires/${questionnaireId}`);
}

export async function getQuestionnaire(
  db: FirestoreLike,
  questionnaireId: string,
): Promise<QuestionnaireDoc | undefined> {
  const r = await getDoc<QuestionnaireDoc>(
    db,
    `questionnaires/${questionnaireId}`,
  );
  return r.data;
}

export function revisionRef(
  db: FirestoreLike,
  questionnaireId: string,
  versionNumber: number,
) {
  return db.doc(
    `questionnaires/${questionnaireId}/revisions/${versionNumber}`,
  );
}

export async function listRevisions(
  db: FirestoreLike,
  questionnaireId: string,
): Promise<Array<{ id: string; data: QuestionnaireRevisionDoc }>> {
  return queryDocs<QuestionnaireRevisionDoc>(
    db,
    `questionnaires/${questionnaireId}/revisions`,
    [],
    { orderBy: [{ field: "versionNumber", direction: "desc" }] },
  );
}

/** 本人の過去票（API-017）。 */
export async function listQuestionnairesByPatient(
  db: FirestoreLike,
  patientUid: string,
): Promise<Array<{ id: string; data: QuestionnaireDoc }>> {
  return queryDocs<QuestionnaireDoc>(db, "questionnaires", [
    { field: "patientUid", op: "==", value: patientUid },
  ], {
    orderBy: [{ field: "finalizedAt", direction: "desc" }],
  });
}
