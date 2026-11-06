import type {
  AnswerDoc,
  IntakeDoc,
  QuestionDoc,
} from "../domain/firestoreDocs.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function intakeRef(db: FirestoreLike, intakeId: string) {
  return db.doc(`intakes/${intakeId}`);
}

export async function getIntake(
  db: FirestoreLike,
  intakeId: string,
): Promise<IntakeDoc | undefined> {
  const r = await getDoc<IntakeDoc>(db, `intakes/${intakeId}`);
  return r.data;
}

export function questionRef(
  db: FirestoreLike,
  intakeId: string,
  questionId: string,
) {
  return db.doc(`intakes/${intakeId}/questions/${questionId}`);
}

export function answerRef(
  db: FirestoreLike,
  intakeId: string,
  questionId: string,
) {
  return db.doc(`intakes/${intakeId}/answers/${questionId}`);
}

export async function listQuestions(
  db: FirestoreLike,
  intakeId: string,
): Promise<Array<{ id: string; data: QuestionDoc }>> {
  return queryDocs<QuestionDoc>(
    db,
    `intakes/${intakeId}/questions`,
    [],
    { orderBy: [{ field: "stepIndex", direction: "asc" }] },
  );
}

export async function listAnswers(
  db: FirestoreLike,
  intakeId: string,
): Promise<Array<{ id: string; data: AnswerDoc }>> {
  return queryDocs<AnswerDoc>(
    db,
    `intakes/${intakeId}/answers`,
    [],
    { orderBy: [{ field: "stepIndex", direction: "asc" }] },
  );
}
