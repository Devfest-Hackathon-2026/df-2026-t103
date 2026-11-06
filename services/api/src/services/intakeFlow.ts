import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type {
  AnswerDoc,
  IntakeDoc,
  QuestionnaireRevisionDoc,
  SummarySection,
} from "../domain/firestoreDocs.js";
import type {
  IntakeFinalizeBody,
  IntakeNextQuestionBody,
  IntakeSummaryBody,
} from "../domain/schemas.js";
import { FIXED_TOPICS } from "../engines/fixedQuestions.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { canonicalJson, sha256Hex } from "../lib/hash.js";
import { requestHash, runIdempotent } from "../lib/idempotency.js";
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { getProfile } from "../repos/accounts.js";
import {
  getIntake,
  listAnswers,
  listQuestions,
} from "../repos/intakes.js";
import { listAttachableMedications } from "../repos/medications.js";
import { generateNextQuestion } from "./questionGen.js";
import {
  appendQuestion,
  DRAFT_EXPIRED,
  draftExpiredError,
  expired,
} from "./intakes.js";
import type { NextQuestionSpec } from "./questionGen.js";

function getOwned(
  doc: IntakeDoc | undefined,
  exists: boolean,
  uid: string,
): IntakeDoc {
  if (!exists || doc === undefined || doc.patientUid !== uid) {
    throw ApiError.notFound("問診が見つかりません。");
  }
  return doc;
}

/**
 * API-012 POST /intakes/{id}/next-question。
 * LLM/固定質問を生成し、質問スナップショットを永続化してから返す（FR-I03）。
 * LLM呼出しは外部I/Oなのでトランザクション外で実行する。
 */
export interface IssuedQuestion {
  questionId: string;
  stepIndex: number;
  questionText: string;
  topic: string;
  options: Array<{ code: string; label: string }>;
  generatedBy: NextQuestionSpec["generatedBy"];
  modelVersion: string | null;
  questionRevision: number;
}

export async function requestNextQuestion(
  deps: Deps,
  params: { uid: string; intakeId: string; body: IntakeNextQuestionBody },
): Promise<{
  intakeId: string;
  intakeRevision: number;
  question: IssuedQuestion | null;
}> {
  const intake = getOwned(
    await getIntake(deps.db, params.intakeId),
    true,
    params.uid,
  );
  if (intake.status !== "questioning") {
    throw ApiError.precondition(
      "この操作は現在の問診状態では実行できません。",
    );
  }
  const spec = await generateNextQuestion(deps, {
    intakeId: params.intakeId,
    intake,
  });
  if (spec === null) {
    return {
      intakeId: params.intakeId,
      intakeRevision: intake.revision,
      question: null,
    };
  }
  const appended = await appendQuestion(deps, {
    uid: params.uid,
    intakeId: params.intakeId,
    expectedIntakeRevision: params.body.expectedIntakeRevision,
    question: spec,
  });
  return {
    intakeId: params.intakeId,
    intakeRevision: appended.intakeRevision,
    question: {
      questionId: appended.questionId,
      stepIndex: intake.questionCount,
      questionText: spec.questionText,
      topic: spec.topic,
      options: spec.options,
      generatedBy: spec.generatedBy,
      modelVersion: spec.modelVersion ?? null,
      questionRevision: 1,
    },
  };
}

interface BuiltSummary {
  chiefComplaint: { value: string | null; source: string };
  sections: Record<string, SummarySection>;
  unansweredTopics: string[];
  bodyLocations: string[];
  medicationSnapshots: Array<{
    medicationId: string;
    displayName: string;
    confirmed: true;
  }>;
  medicalHistorySnapshot: Array<{ conditionText: string; source: string }>;
}

/**
 * 要約を構成する（FR-I07）。
 * - 未回答は「なし」に変換せず unansweredTopics へ（03 §3.6）
 * - 原因・診断を付け足さない
 * - 薬は患者が選択し確認済みのもののみ（FR-M07, BR-05）
 */
async function buildSummary(
  deps: Deps,
  intake: IntakeDoc,
  intakeId: string,
): Promise<BuiltSummary> {
  const [questions, answers, profile, attachables] = await Promise.all([
    listQuestions(deps.db, intakeId),
    listAnswers(deps.db, intakeId),
    getProfile(deps.db, intake.patientUid),
    listAttachableMedications(deps.db, intake.patientUid),
  ]);
  const answerByQuestion = new Map<string, AnswerDoc>(
    answers.map((a) => [a.data.questionId, a.data]),
  );
  const sections: Record<string, SummarySection> = {};
  const unanswered = new Set<string>();
  const askedTopics = new Set<string>();

  for (const q of questions) {
    if (q.data.status === "invalidated") continue;
    askedTopics.add(q.data.topic);
    const a = answerByQuestion.get(q.id);
    const labels = q.data.options
      .filter((o) => a?.selectedCodes.includes(o.code) ?? false)
      .map((o) => o.label);
    const value =
      a !== undefined && a.answerState === "answered"
        ? [
            labels.join("、"),
            ...(a.freeText !== null && a.freeText !== undefined &&
            a.freeText !== ""
              ? [a.freeText]
              : []),
          ]
            .filter((s) => s !== "")
            .join("　") || null
        : null;
    const state =
      a === undefined
        ? ("not_asked" as const)
        : a.answerState;
    sections[q.data.topic] = {
      value,
      source: a !== undefined ? `answer:${q.id}` : null,
      answerState: state,
    };
    if (state !== "answered") unanswered.add(q.data.topic);
  }
  for (const topic of FIXED_TOPICS) {
    if (!askedTopics.has(topic)) {
      unanswered.add(topic);
      sections[topic] = { value: null, source: null, answerState: "not_asked" };
    }
  }

  return {
    chiefComplaint: {
      value: intake.initialSymptomText ?? null,
      source: "patient",
    },
    sections,
    unansweredTopics: [...unanswered],
    bodyLocations: intake.bodyLocations,
    medicationSnapshots: attachables
      .filter((m) => m.data.confirmationStatus === "confirmed")
      .map((m) => ({
        medicationId: m.id,
        displayName: m.data.displayName,
        confirmed: true as const,
      })),
    medicalHistorySnapshot: (profile?.medicalHistory ?? []).map((h) => ({
      conditionText: h.conditionText,
      source: "patient_profile",
    })),
  };
}

/**
 * API-015 POST /intakes/{id}/summary。
 * questioning→review に遷移し、要約を返す（繰り返し呼出し可・編集後の再生成）。
 */
export async function summarizeIntake(
  deps: Deps,
  params: { uid: string; intakeId: string; body: IntakeSummaryBody },
): Promise<{
  intakeId: string;
  status: "review";
  intakeRevision: number;
  summary: BuiltSummary;
}> {
  const intake = getOwned(
    await getIntake(deps.db, params.intakeId),
    true,
    params.uid,
  );
  if (intake.status !== "questioning" && intake.status !== "review") {
    throw ApiError.precondition(
      "要約は質問完了後にのみ実行できます。",
    );
  }
  const summary = await buildSummary(deps, intake, params.intakeId);
  const txResult = await deps.db.runTransaction(async (tx) => {
    const ref = deps.db.doc(`intakes/${params.intakeId}`);
    const snap = await tx.get(ref);
    const doc = getOwned(snap.data() as IntakeDoc | undefined, snap.exists, params.uid);
    if (doc.revision !== params.body.expectedIntakeRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "他の端末で更新されています。最新の状態を取得してください。",
      );
    }
    if (expired(deps, doc)) {
      tx.update(ref, {
        status: "archived",
        updatedAt: Timestamp.fromDate(deps.clock.now()),
      });
      return DRAFT_EXPIRED;
    }
    const next = doc.revision + 1;
    tx.update(ref, {
      status: "review",
      revision: next,
      updatedAt: Timestamp.fromDate(deps.clock.now()),
      reviewedAt: Timestamp.fromDate(deps.clock.now()),
      // 確認した要約内容の証跡。finalize 時の再構成と照合する。
      reviewedSummaryHash: sha256Hex(canonicalJson(summary)),
    });
    return next;
  });
  if (typeof txResult !== "number") throw draftExpiredError();
  const revision = txResult;
  return {
    intakeId: params.intakeId,
    status: "review",
    intakeRevision: revision,
    summary,
  };
}

/**
 * API-016 POST /intakes/{id}/finalize。
 * 確定票（questionnaires + immutable revisions/1）を生成し intake=finalized。
 * VAL-007: 未レビュー（status != review）は 412。
 */
export async function finalizeIntake(
  deps: Deps,
  params: {
    uid: string;
    intakeId: string;
    body: IntakeFinalizeBody;
    idempotencyKey: string;
    requestId?: string;
  },
): Promise<{
  intakeId: string;
  questionnaireId: string;
  questionnaireRevision: number;
  status: "finalized";
}> {
  const intake = getOwned(
    await getIntake(deps.db, params.intakeId),
    true,
    params.uid,
  );
  // 未レビュー検査（VAL-007）は runIdempotent 内のtxで行う。
  // 外側で行うと冪等リプレイ時に finalized → 412 となり同一結果を再生できない。
  // スナップショット素材はトランザクション外で取得（外部読み込みをtxに入れない）
  const [questions, answers] = await Promise.all([
    listQuestions(deps.db, params.intakeId),
    listAnswers(deps.db, params.intakeId),
  ]);
  const summary = await buildSummary(deps, intake, params.intakeId);
  const snapshotHash = sha256Hex(
    canonicalJson({
      questions: questions.map((q) => ({
        id: q.id,
        topic: q.data.topic,
        revision: q.data.questionRevision,
        stepIndex: q.data.stepIndex,
      })),
      answers: answers.map((a) => a.data),
    }),
  );

  const { result, replayed } = await runIdempotent<
    | { questionnaireId: string; questionnaireRevision: number }
    | typeof DRAFT_EXPIRED
  >(deps, {
    namespace: "intake_finalize",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, {
      intakeId: params.intakeId,
      body: params.body,
    }),
    execute: async (tx) => {
      const ref = deps.db.doc(`intakes/${params.intakeId}`);
      const snap = await tx.get(ref);
      const doc = getOwned(
        snap.data() as IntakeDoc | undefined,
        snap.exists,
        params.uid,
      );
      if (doc.revision !== params.body.expectedIntakeRevision) {
        throw ApiError.conflict(
          ErrorCodes.REVISION_CONFLICT,
          "他の端末で更新されています。最新の状態を取得してください。",
        );
      }
      if (expired(deps, doc)) {
        tx.update(ref, {
          status: "archived",
          updatedAt: Timestamp.fromDate(deps.clock.now()),
        });
        // sentinel を結果として保存: リプレイでも同じ期限切れ応答を返す
        return DRAFT_EXPIRED;
      }
      if (doc.status !== "review") {
        throw ApiError.precondition(
          "確定する前にレビュー（要約の確認）が必要です。",
        );
      }
      // 確認後に薬・既往歴・回答が変わった場合は確定内容がレビューと
      // 乖離するため、再構成した要約とレビュー時のハッシュを照合する。
      if (
        doc.reviewedSummaryHash !==
        sha256Hex(canonicalJson(summary))
      ) {
        throw ApiError.precondition(
          "要約の確認後に内容が変更されました。再度要約を確認してください。",
        );
      }
      const now = Timestamp.fromDate(deps.clock.now());
      const qnRef = deps.db.collection("questionnaires").doc();
      const revRef = qnRef.collection("revisions").doc("1");
      const revDoc: QuestionnaireRevisionDoc = {
        versionNumber: 1,
        patientUid: params.uid,
        schemaVersion: "1",
        chiefComplaint: summary.chiefComplaint,
        sections: summary.sections,
        bodyLocations: summary.bodyLocations,
        medicalHistorySnapshot: summary.medicalHistorySnapshot,
        medicationSnapshots: summary.medicationSnapshots,
        unansweredTopics: summary.unansweredTopics,
        rawAnswerSnapshotHash: `sha256:${snapshotHash}`,
        summaryReviewConfirmedAt: now,
        createdAt: now,
      };
      tx.create(revRef, revDoc as unknown as DocumentData);
      tx.create(qnRef, {
        patientUid: params.uid,
        intakeId: params.intakeId,
        status: "finalized",
        latestRevision: 1,
        reviewedAt: now,
        finalizedAt: now,
        createdAt: now,
      } as DocumentData);
      tx.update(ref, {
        status: "finalized",
        revision: doc.revision + 1,
        finalizedAt: now,
        updatedAt: now,
      });
      return {
        questionnaireId: qnRef.id,
        questionnaireRevision: 1,
      };
    },
  });
  if ("kind" in result) throw draftExpiredError();
  // 冪等リプレイでは確定が起きていないため監査も発行しない
  if (!replayed) {
    await audit(deps, {
      actorType: "patient",
      actorUidHash: auditUidHash(deps, params.uid),
      action: AUDIT_ACTIONS.INTAKE_FINALIZED,
      resourceType: "questionnaires",
      resourceIdHash: auditResourceHash(deps, result.questionnaireId),
      ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    });
  }
  return {
    intakeId: params.intakeId,
    questionnaireId: result.questionnaireId,
    questionnaireRevision: result.questionnaireRevision,
    status: "finalized",
  };
}
