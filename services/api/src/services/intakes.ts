import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type {
  AnswerDoc,
  IntakeDoc,
  QuestionDoc,
} from "../domain/firestoreDocs.js";
import type {
  IntakeAnswerBody,
  IntakeAnswerPatchBody,
  IntakeCreateBody,
  IntakeSymptomsBody,
} from "../domain/schemas.js";
import {
  AI_POLICY_VERSION,
  INTAKE_MAX_QUESTIONS,
  QUESTION_GRAPH_VERSION,
  SAFETY_RULESET_VERSION,
  assertIntakeTransition,
  checkRedFlags,
  isResumableIntake,
  validateSymptomText,
} from "../domain/intake.js";
import type {
  IntakeStatus,
  QuestionGeneratedBy,
} from "../domain/types.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { requestHash, runIdempotent } from "../lib/idempotency.js";
import { audit, auditUidHash } from "../lib/audit.js";
import {
  answerRef,
  getIntake,
  listAnswers,
  listQuestions,
  questionRef,
} from "../repos/intakes.js";

export interface IntakeDetail {
  intakeId: string;
  status: IntakeStatus;
  revision: number;
  initialSymptomText: string | null;
  bodyLocations: string[];
  currentQuestionId: string | null;
  questionCount: number;
  safetyFlags: string[];
  aiEnabledForThisIntake: boolean;
  questions: Array<{ questionId: string; data: QuestionDoc }>;
  answers: Array<{ answerId: string; data: AnswerDoc }>;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  finalizedAt: string | null;
}

function toIso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  return null;
}

function toDetail(intakeId: string, doc: IntakeDoc): IntakeDetail {
  return {
    intakeId,
    status: doc.status,
    revision: doc.revision,
    initialSymptomText: doc.initialSymptomText ?? null,
    bodyLocations: doc.bodyLocations,
    currentQuestionId: doc.currentQuestionId ?? null,
    questionCount: doc.questionCount,
    safetyFlags: doc.safetyFlags,
    aiEnabledForThisIntake: doc.aiEnabledForThisIntake,
    questions: [],
    answers: [],
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
    expiresAt: toIso(doc.expiresAt),
    finalizedAt: toIso(doc.finalizedAt),
  };
}

/** 所有者でない・存在しない場合は 404（存在秘匿）。 */
async function getOwnedIntake(
  deps: Deps,
  uid: string,
  intakeId: string,
): Promise<IntakeDoc> {
  const doc = await getIntake(deps.db, intakeId);
  if (!doc || doc.patientUid !== uid) {
    throw ApiError.notFound("問診が見つかりません。");
  }
  return doc;
}

function expired(deps: Deps, doc: IntakeDoc): boolean {
  if (!isResumableIntake(doc.status)) return false;
  const exp = doc.expiresAt;
  const at =
    exp && typeof exp === "object" && "toDate" in exp
      ? (exp as { toDate(): Date }).toDate()
      : undefined;
  return at !== undefined && at.getTime() <= deps.clock.now().getTime();
}

/**
 * tx内で archived への遷移を commit したことを示す sentinel。
 * txコールバック内で throw すると実Firestoreではtx全体が abort し
 * archived 書込も巻き戻るため、マーカーを返してcommit後に投げる。
 */
const DRAFT_EXPIRED = { kind: "draft_expired" } as const;

function draftExpiredError(): ApiError {
  return ApiError.precondition(
    "この下書きは保存期限を過ぎています。新しい問診を開始してください。",
  );
}

/**
 * API-009 POST /intakes。
 * draft を revision=1 で作成（下書きは短期保存、FR-I06）。
 */
export async function createIntake(
  deps: Deps,
  params: { uid: string; body: IntakeCreateBody; idempotencyKey: string },
): Promise<{ intakeId: string; status: "draft"; revision: number }> {
  const { result } = await runIdempotent<{ intakeId: string }>(deps, {
    namespace: "intake_create",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, params.body),
    execute: async (tx) => {
      const ref = deps.db.collection("intakes").doc();
      const now = deps.clock.now();
      const doc: IntakeDoc = {
        patientUid: params.uid,
        status: "draft",
        bodyLocations: [],
        questionCount: 0,
        revision: 1,
        questionGraphVersion: QUESTION_GRAPH_VERSION,
        safetyRulesetVersion: SAFETY_RULESET_VERSION,
        aiPolicyVersion: AI_POLICY_VERSION,
        // 本番のAI承認設定（ADR-009）は procurement 待ち。既定は固定質問のみ。
        aiEnabledForThisIntake: false,
        safetyFlags: [],
        expiresAt: Timestamp.fromMillis(
          now.getTime() + deps.config.intakeDraftTtlDays * 24 * 3600_000,
        ),
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      };
      tx.create(ref, doc as unknown as DocumentData);
      return { intakeId: ref.id };
    },
  });
  return { intakeId: result.intakeId, status: "draft", revision: 1 };
}

/**
 * API-010 GET /intakes/{id}。
 * 中断再開（FR-I06）に必要な質問・回答スナップショットを含めて返す。
 */
export async function getIntakeDetail(
  deps: Deps,
  params: { uid: string; intakeId: string },
): Promise<IntakeDetail> {
  const doc = await getOwnedIntake(deps, params.uid, params.intakeId);
  const detail = toDetail(params.intakeId, doc);
  const [questions, answers] = await Promise.all([
    listQuestions(deps.db, params.intakeId),
    listAnswers(deps.db, params.intakeId),
  ]);
  detail.questions = questions.map((q) => ({
    questionId: q.id,
    data: q.data,
  }));
  detail.answers = answers.map((a) => ({ answerId: a.id, data: a.data }));
  return detail;
}

/**
 * API-011 POST /intakes/{id}/symptoms。
 * 初期症状と部位を保存し draft→questioning へ遷移。
 * 安全ルールは AI非依存の固定判定（FR-I09）。楽観ロックを検査する。
 */
export async function submitSymptoms(
  deps: Deps,
  params: { uid: string; intakeId: string; body: IntakeSymptomsBody },
): Promise<{ intakeId: string; status: IntakeStatus; revision: number }> {
  const text = validateSymptomText(params.body.initialSymptomText);
  const flags = checkRedFlags(text);
  const body = params.body;

  const result = await deps.db.runTransaction(async (tx) => {
    const ref = deps.db.doc(`intakes/${params.intakeId}`);
    const snap = await tx.get(ref);
    const doc = snap.data() as IntakeDoc | undefined;
    if (!snap.exists || !doc || doc.patientUid !== params.uid) {
      throw ApiError.notFound("問診が見つかりません。");
    }
    if (doc.revision !== body.expectedIntakeRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "他の端末で更新されています。最新の状態を取得してください。",
      );
    }
    if (expired(deps, doc)) {
      tx.update(ref, { status: "archived", updatedAt: nowTs(deps) });
      return DRAFT_EXPIRED;
    }
    // draft からの初回入力、または questioning 中の修正を許可
    if (doc.status !== "draft" && doc.status !== "questioning") {
      assertIntakeTransition(doc.status, "questioning");
    }
    tx.update(ref, {
      status: "questioning",
      initialSymptomText: text,
      bodyLocations: body.bodyLocations,
      safetyFlags: flags,
      revision: doc.revision + 1,
      updatedAt: nowTs(deps),
    });
    return {
      intakeId: params.intakeId,
      status: "questioning" as IntakeStatus,
      revision: doc.revision + 1,
    };
  });
  if ("kind" in result) throw draftExpiredError();
  return result;
}

/**
 * API-013 POST /intakes/{id}/answers。
 * questionRevision・intake revision の一致を必須とし、
 * 患者原文（freeText）をそのまま保存する（FR-I05）。
 */
export async function saveAnswer(
  deps: Deps,
  params: { uid: string; intakeId: string; body: IntakeAnswerBody },
): Promise<{ answerId: string; intakeRevision: number }> {
  const body = params.body;
  // 選択肢コードは当該質問の options に存在するものだけ（サービス側でも検査）
  const result = await deps.db.runTransaction(async (tx) => {
    const intakeSnap = await tx.get(deps.db.doc(`intakes/${params.intakeId}`));
    const intake = intakeSnap.data() as IntakeDoc | undefined;
    if (!intakeSnap.exists || !intake || intake.patientUid !== params.uid) {
      throw ApiError.notFound("問診が見つかりません。");
    }
    if (intake.revision !== body.expectedIntakeRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "他の端末で更新されています。最新の状態を取得してください。",
      );
    }
    if (expired(deps, intake)) {
      tx.update(deps.db.doc(`intakes/${params.intakeId}`), {
        status: "archived",
        updatedAt: nowTs(deps),
      });
      return DRAFT_EXPIRED;
    }
    if (intake.status !== "questioning" && intake.status !== "review") {
      throw ApiError.precondition(
        "この操作は現在の問診状態では実行できません。",
      );
    }
    const qSnap = await tx.get(
      questionRef(deps.db, params.intakeId, body.questionId),
    );
    const question = qSnap.data() as QuestionDoc | undefined;
    if (!qSnap.exists || !question) {
      throw ApiError.notFound("質問が見つかりません。");
    }
    if (question.status === "invalidated") {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "この質問は無効化されました。最新の質問に回答してください。",
      );
    }
    if (question.questionRevision !== body.questionRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "質問が更新されています。最新の質問に回答してください。",
      );
    }
    const validCodes = new Set(question.options.map((o) => o.code));
    for (const code of body.selectedCodes) {
      if (!validCodes.has(code)) {
        throw ApiError.validation([
          { field: "selectedCodes", message: "選択肢に存在しないコードです。" },
        ]);
      }
    }
    const now = nowTs(deps);
    const answerDoc: AnswerDoc = {
      questionId: body.questionId,
      questionRevision: body.questionRevision,
      stepIndex: question.stepIndex,
      selectedCodes: body.selectedCodes,
      freeText: body.freeText ?? null,
      answerState: body.answerState,
      answerSource: "patient",
      answeredAt: now,
      updatedAt: now,
    };
    tx.set(
      answerRef(deps.db, params.intakeId, body.questionId),
      answerDoc as unknown as DocumentData,
    );
    tx.update(questionRef(deps.db, params.intakeId, body.questionId), {
      status: "answered",
    });
    tx.update(deps.db.doc(`intakes/${params.intakeId}`), {
      revision: intake.revision + 1,
      updatedAt: now,
    });
    return {
      answerId: body.questionId,
      intakeRevision: intake.revision + 1,
    };
  });
  if ("kind" in result) throw draftExpiredError();
  return result;
}

/**
 * API-014 PATCH /intakes/{id}/answers/{answerId}（answerId=questionId）。
 * 回答編集は後続の active 質問を無効化する（分岐の再評価、04 §5.4）。
 */
export async function patchAnswer(
  deps: Deps,
  params: { uid: string; intakeId: string; answerId: string; body: IntakeAnswerPatchBody },
): Promise<{ answerId: string; intakeRevision: number }> {
  const body = params.body;
  return deps.db.runTransaction(async (tx) => {
    const intakeSnap = await tx.get(deps.db.doc(`intakes/${params.intakeId}`));
    const intake = intakeSnap.data() as IntakeDoc | undefined;
    if (!intakeSnap.exists || !intake || intake.patientUid !== params.uid) {
      throw ApiError.notFound("問診が見つかりません。");
    }
    if (intake.revision !== body.expectedIntakeRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "他の端末で更新されています。最新の状態を取得してください。",
      );
    }
    if (intake.status !== "questioning" && intake.status !== "review") {
      throw ApiError.precondition(
        "この操作は現在の問診状態では実行できません。",
      );
    }
    const aRef = answerRef(deps.db, params.intakeId, params.answerId);
    const aSnap = await tx.get(aRef);
    const answer = aSnap.data() as AnswerDoc | undefined;
    if (!aSnap.exists || !answer) {
      throw ApiError.notFound("回答が見つかりません。");
    }
    if (answer.questionRevision !== body.questionRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "質問が更新されています。最新の質問に回答してください。",
      );
    }
    const now = nowTs(deps);
    const update: Record<string, unknown> = { updatedAt: now };
    if (body.selectedCodes !== undefined) {
      const qSnap = await tx.get(
        questionRef(deps.db, params.intakeId, params.answerId),
      );
      const question = qSnap.data() as QuestionDoc | undefined;
      const validCodes = new Set(
        question?.options.map((o) => o.code) ?? [],
      );
      for (const code of body.selectedCodes) {
        if (!validCodes.has(code)) {
          throw ApiError.validation([
            {
              field: "selectedCodes",
              message: "選択肢に存在しないコードです。",
            },
          ]);
        }
      }
      update.selectedCodes = body.selectedCodes;
    }
    if (body.freeText !== undefined) update.freeText = body.freeText;
    if (body.answerState !== undefined) update.answerState = body.answerState;
    tx.update(aRef, update);

    // 回答編集で分岐が変わり得るため、当該回答より後の active 質問を無効化
    const questions = await listQuestions(deps.db, params.intakeId);
    for (const q of questions) {
      if (q.data.stepIndex > answer.stepIndex && q.data.status === "active") {
        tx.update(questionRef(deps.db, params.intakeId, q.id), {
          status: "invalidated",
        });
      }
    }
    tx.update(deps.db.doc(`intakes/${params.intakeId}`), {
      revision: intake.revision + 1,
      updatedAt: now,
    });
    return {
      answerId: params.answerId,
      intakeRevision: intake.revision + 1,
    };
  });
}

/**
 * 質問の追加（API-012 next-question から使うドメイン操作）。
 * 発行された質問はスナップショットとして永続化してから返す（FR-I03）。
 */
export async function appendQuestion(
  deps: Deps,
  params: {
    uid: string;
    intakeId: string;
    expectedIntakeRevision: number;
    question: {
      questionText: string;
      topic: string;
      options: Array<{ code: string; label: string }>;
      generatedBy: QuestionGeneratedBy;
      modelVersion?: string;
    };
  },
): Promise<{ questionId: string; intakeRevision: number }> {
  const { question } = params;
  const result = await deps.db.runTransaction(async (tx) => {
    const ref = deps.db.doc(`intakes/${params.intakeId}`);
    const snap = await tx.get(ref);
    const intake = snap.data() as IntakeDoc | undefined;
    if (!snap.exists || !intake || intake.patientUid !== params.uid) {
      throw ApiError.notFound("問診が見つかりません。");
    }
    if (intake.revision !== params.expectedIntakeRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "他の端末で更新されています。最新の状態を取得してください。",
      );
    }
    if (expired(deps, intake)) {
      tx.update(ref, { status: "archived", updatedAt: nowTs(deps) });
      return DRAFT_EXPIRED;
    }
    if (intake.status !== "questioning") {
      throw ApiError.precondition(
        "この操作は現在の問診状態では実行できません。",
      );
    }
    if (intake.questionCount >= INTAKE_MAX_QUESTIONS) {
      throw ApiError.precondition(
        "質問数の上限に達しました。確認画面へ進んでください。",
      );
    }
    const qRef = deps.db
      .collection(`intakes/${params.intakeId}/questions`)
      .doc();
    const now = nowTs(deps);
    const doc: QuestionDoc = {
      stepIndex: intake.questionCount,
      questionText: question.questionText,
      topic: question.topic,
      options: question.options,
      generatedBy: question.generatedBy,
      ...(question.modelVersion !== undefined
        ? { modelVersion: question.modelVersion }
        : {}),
      questionRevision: 1,
      status: "active",
      createdAt: now,
    };
    tx.create(qRef, doc as unknown as DocumentData);
    tx.update(ref, {
      questionCount: intake.questionCount + 1,
      currentQuestionId: qRef.id,
      revision: intake.revision + 1,
      updatedAt: now,
    });
    return { questionId: qRef.id, intakeRevision: intake.revision + 1 };
  });
  if ("kind" in result) throw draftExpiredError();
  return result;
}

/**
 * 状態遷移の汎用操作（API-015 review、API-016 finalize から利用）。
 * 遷移とリビジョン確認を一トランザクションで行う。
 */
export async function transitionIntake(
  deps: Deps,
  params: {
    uid: string;
    intakeId: string;
    to: IntakeStatus;
    expectedIntakeRevision: number;
    extra?: Record<string, unknown>;
  },
): Promise<{ status: IntakeStatus; revision: number }> {
  const result = await deps.db.runTransaction(async (tx) => {
    const ref = deps.db.doc(`intakes/${params.intakeId}`);
    const snap = await tx.get(ref);
    const doc = snap.data() as IntakeDoc | undefined;
    if (!snap.exists || !doc || doc.patientUid !== params.uid) {
      throw ApiError.notFound("問診が見つかりません。");
    }
    if (doc.revision !== params.expectedIntakeRevision) {
      throw ApiError.conflict(
        ErrorCodes.REVISION_CONFLICT,
        "他の端末で更新されています。最新の状態を取得してください。",
      );
    }
    if (expired(deps, doc)) {
      tx.update(ref, { status: "archived", updatedAt: nowTs(deps) });
      return DRAFT_EXPIRED;
    }
    assertIntakeTransition(doc.status, params.to);
    tx.update(ref, {
      status: params.to,
      revision: doc.revision + 1,
      updatedAt: nowTs(deps),
      ...(params.to === "finalized" ? { finalizedAt: nowTs(deps) } : {}),
      ...(params.extra ?? {}),
    });
    return { status: params.to, revision: doc.revision + 1 };
  });
  if ("kind" in result) throw draftExpiredError();
  return result;
}

/** 問診の監査イベント（#11 の API 層から利用）。 */
export async function auditIntake(
  deps: Deps,
  params: {
    uid: string;
    action: string;
    intakeId: string;
    requestId?: string;
    outcome?: string;
  },
): Promise<void> {
  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, params.uid),
    action: params.action,
    resourceType: "intakes",
    resourceIdHash: params.intakeId,
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    ...(params.outcome !== undefined ? { outcome: params.outcome } : {}),
  });
}

function nowTs(deps: Deps): Timestamp {
  return Timestamp.fromDate(deps.clock.now());
}
