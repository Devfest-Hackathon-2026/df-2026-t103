import { ApiError } from "../lib/errors.js";
import type { IntakeStatus } from "./types.js";

/** 質問数の暫定上限（04 §5.4）。 */
export const INTAKE_MAX_QUESTIONS = 12;

/** 初期症状の最大文字数（04 §5.4 暫定1000字）。 */
export const INTAKE_SYMPTOM_MAX_CHARS = 1000;

/** 固定質問セット・安全ルール・AI検証の版管理。変更時はインクリメント。 */
export const QUESTION_GRAPH_VERSION = "graph-2026-11-01";
export const SAFETY_RULESET_VERSION = "safety-2026-11-01";
export const AI_POLICY_VERSION = "ai-policy-2026-11-01";

/**
 * FR-I02 体の部位コード（前面/背面・テキスト代替を想定した語彙）。
 * 詳細な部位ツリーはクライアント側リソースとして版管理する。
 */
export const BODY_LOCATIONS = [
  "whole_body",
  "head",
  "face",
  "neck",
  "throat",
  "chest",
  "abdomen",
  "upper_back",
  "lower_back",
  "left_shoulder",
  "right_shoulder",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "left_knee",
  "right_knee",
  "left_foot",
  "right_foot",
  "skin",
  "other",
] as const;
export type BodyLocation = (typeof BODY_LOCATIONS)[number];

const INTAKE_TRANSITIONS: Record<IntakeStatus, IntakeStatus[]> = {
  draft: ["safety_check", "questioning", "archived"],
  safety_check: ["questioning", "archived"],
  questioning: ["review", "archived"],
  review: ["questioning", "finalized", "archived"],
  finalized: [],
  archived: [],
};

export function canIntakeTransition(
  from: IntakeStatus,
  to: IntakeStatus,
): boolean {
  return INTAKE_TRANSITIONS[from].includes(to);
}

/** 不正遷移は 412（前置条件未充足）。 */
export function assertIntakeTransition(
  from: IntakeStatus,
  to: IntakeStatus,
): void {
  if (!canIntakeTransition(from, to)) {
    throw ApiError.precondition(
      "この操作は現在の問診状態では実行できません。",
    );
  }
}

/** 編集中の下書き（再開可能な状態）か。 */
export function isResumableIntake(status: IntakeStatus): boolean {
  return (
    status === "draft" ||
    status === "safety_check" ||
    status === "questioning" ||
    status === "review"
  );
}

/**
 * FR-I01 初期症状の固定検査ポリシー（AI非依存）。
 * - 空・空白のみ・制御文字のみを拒否
 * - 1000字上限
 * - 意味のある文字（和文・英数）を1字以上含むこと（記号のみ入力を拒否）
 */
export function validateSymptomText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw ApiError.validation([
      { field: "initialSymptomText", message: "症状を入力してください。" },
    ]);
  }
  if (trimmed.length > INTAKE_SYMPTOM_MAX_CHARS) {
    throw ApiError.validation([
      {
        field: "initialSymptomText",
        message: `症状は${INTAKE_SYMPTOM_MAX_CHARS}文字以内で入力してください。`,
      },
    ]);
  }
  if (!/[぀-ヿ一-鿿a-zA-Z0-9]/u.test(trimmed)) {
    throw ApiError.validation([
      {
        field: "initialSymptomText",
        message: "症状は文字で入力してください。",
      },
    ]);
  }
  return trimmed;
}

/**
 * 安全ルール（FR-I09 緊兆候の固定的検出。AI任せにしない）。
 * 検出しても入力を遮断せず、利用者への注意喚起フラグとして保持する。
 */
const RED_FLAG_TERMS = [
  "意識がない",
  "意識不明",
  "呼吸ができない",
  "呼吸困難",
  "胸が痛い",
  "胸痛",
  "大量出血",
  "麻痺",
  "けいれん",
];

export function checkRedFlags(symptomText: string): string[] {
  return RED_FLAG_TERMS.filter((t) => symptomText.includes(t));
}
