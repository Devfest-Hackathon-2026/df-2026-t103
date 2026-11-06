import type { DeletionStepStatus } from "./types.js";

/** 04_DB設計書 §5.11/§10.2 の削除ステップ（実行順）。 */
export const DELETION_STEPS = [
  "freeze",
  "intakeSubcollections",
  "questionnaires",
  "medications",
  "uploads",
  "storageObjects",
  "authAccount",
  "residualScan",
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];

export function initialSteps(): Record<DeletionStep, DeletionStepStatus> {
  return Object.fromEntries(
    DELETION_STEPS.map((s) => [s, "pending" as const]),
  ) as Record<DeletionStep, DeletionStepStatus>;
}

/** リトライ時のバックオフ（指数・上限1時間）。 */
export function retryDelayMs(attemptCount: number): number {
  const base = 60_000;
  const delay = base * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(delay, 3_600_000);
}

/** 期限超過アラートの閾値（SLO-07: 予定時刻+24h未完了）。 */
export const OVERDUE_ALERT_MS = 24 * 3600_000;

/**
 * 実行中クレームの失効時間。running のままこの時間を超えたジョブは
 * ワーカー死亡とみなして回収スキャンで再クレームする。
 */
export const CLAIM_TTL_MS = 15 * 60_000;
