import type { Deps } from "../deps.js";
import type { QuestionnaireRevisionDoc } from "../domain/firestoreDocs.js";
import { ApiError } from "../lib/errors.js";
import {
  getQuestionnaire,
  listQuestionnairesByPatient,
  listRevisions,
} from "../repos/questionnaires.js";
import { getDoc } from "../repos/helpers.js";

function toIso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  return null;
}

export interface QuestionnaireListItem {
  questionnaireId: string;
  intakeId: string;
  status: string;
  latestRevision: number;
  finalizedAt: string | null;
  createdAt: string | null;
}

/** API-017 GET /questionnaires — 本人の過去票一覧。 */
export async function listMyQuestionnaires(
  deps: Deps,
  params: { uid: string },
): Promise<{ questionnaires: QuestionnaireListItem[] }> {
  const rows = await listQuestionnairesByPatient(deps.db, params.uid);
  return {
    questionnaires: rows.map((r) => ({
      questionnaireId: r.id,
      intakeId: r.data.intakeId,
      status: r.data.status,
      latestRevision: r.data.latestRevision,
      finalizedAt: toIso(r.data.finalizedAt),
      createdAt: toIso(r.data.createdAt),
    })),
  };
}

export interface QuestionnaireDetail {
  questionnaireId: string;
  intakeId: string;
  status: string;
  latestRevision: number;
  finalizedAt: string | null;
  createdAt: string | null;
  /** 全版の番号・日時・ハッシュ（不変履歴の参照）。 */
  revisions: Array<{
    versionNumber: number;
    createdAt: string | null;
    rawAnswerSnapshotHash: string;
  }>;
  /** 取得した版（既定は latestRevision）。 */
  revision: {
    versionNumber: number;
    schemaVersion: string;
    chiefComplaint: { value: string | null; source: string };
    sections: Record<
      string,
      { value: string | null; source: string | null; answerState: string }
    >;
    bodyLocations: string[];
    medicalHistorySnapshot: Array<{ conditionText: string; source: string }>;
    medicationSnapshots: Array<{
      medicationId: string;
      displayName: string;
      confirmed: true;
    }>;
    unansweredTopics: string[];
    rawAnswerSnapshotHash: string;
    summaryReviewConfirmedAt: string | null;
    createdAt: string | null;
  };
}

function serializeRevision(
  doc: QuestionnaireRevisionDoc,
): QuestionnaireDetail["revision"] {
  return {
    versionNumber: doc.versionNumber,
    schemaVersion: doc.schemaVersion,
    chiefComplaint: doc.chiefComplaint,
    sections: doc.sections,
    bodyLocations: doc.bodyLocations,
    medicalHistorySnapshot: doc.medicalHistorySnapshot,
    medicationSnapshots: doc.medicationSnapshots,
    unansweredTopics: doc.unansweredTopics,
    rawAnswerSnapshotHash: doc.rawAnswerSnapshotHash,
    summaryReviewConfirmedAt: toIso(doc.summaryReviewConfirmedAt),
    createdAt: toIso(doc.createdAt),
  };
}

/**
 * API-018 GET /questionnaires/{id}?revision=N — 問診票取得。
 * 既定は最新版。他人の票は 404 で秘匿。revision は immutable。
 */
export async function getQuestionnaireDetail(
  deps: Deps,
  params: { uid: string; questionnaireId: string; revision?: number },
): Promise<QuestionnaireDetail> {
  const doc = await getQuestionnaire(deps.db, params.questionnaireId);
  if (doc === undefined || doc.patientUid !== params.uid) {
    throw ApiError.notFound("問診票が見つかりません。");
  }
  const version = params.revision ?? doc.latestRevision;
  if (version < 1 || version > doc.latestRevision) {
    throw ApiError.notFound("指定された版が見つかりません。");
  }
  const [revSnap, allRevisions] = await Promise.all([
    getDoc<QuestionnaireRevisionDoc>(
      deps.db,
      `questionnaires/${params.questionnaireId}/revisions/${version}`,
    ),
    listRevisions(deps.db, params.questionnaireId),
  ]);
  if (!revSnap.exists || revSnap.data === undefined) {
    throw ApiError.notFound("指定された版が見つかりません。");
  }
  return {
    questionnaireId: params.questionnaireId,
    intakeId: doc.intakeId,
    status: doc.status,
    latestRevision: doc.latestRevision,
    finalizedAt: toIso(doc.finalizedAt),
    createdAt: toIso(doc.createdAt),
    revisions: allRevisions.map((r) => ({
      versionNumber: r.data.versionNumber,
      createdAt: toIso(r.data.createdAt),
      rawAnswerSnapshotHash: r.data.rawAnswerSnapshotHash,
    })),
    revision: serializeRevision(revSnap.data),
  };
}
