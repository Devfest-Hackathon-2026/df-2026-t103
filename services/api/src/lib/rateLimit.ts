import { ApiError } from "./errors.js";
import type { Clock } from "./clock.js";

interface Bucket {
  count: number;
  resetAtMs: number;
}

export interface RateLimitRule {
  /** ウィンドウ内の最大要求数。 */
  limit: number;
  /** ウィンドウ幅（ミリ秒）。 */
  windowMs: number;
}

/**
 * インメモリ固定ウィンドウのレートリミッタ。
 * 単一インスタンス前提（Cloud Runコンカレンシー内の過負荷防止・悪用抑止用）。
 * 分散制限が必要なら外部ストア実装に差し替える。
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly clock: Clock;
  private lastSweepMs = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** キーを消費し、超過時は 429 を投げる。戻り値は残数等のメタ。 */
  consume(key: string, rule: RateLimitRule): { remaining: number } {
    const nowMs = this.clock.now().getTime();
    this.sweep(nowMs);
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      this.buckets.set(key, { count: 1, resetAtMs: nowMs + rule.windowMs });
      return { remaining: rule.limit - 1 };
    }
    existing.count += 1;
    if (existing.count > rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
      throw ApiError.rateLimited(retryAfter);
    }
    return { remaining: Math.max(0, rule.limit - existing.count) };
  }

  private sweep(nowMs: number): void {
    // 掃除は低頻度で十分（バケット数が肥大化するのを防ぐ）
    if (nowMs - this.lastSweepMs < 60_000) return;
    this.lastSweepMs = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= nowMs) this.buckets.delete(key);
    }
    if (this.buckets.size > 50_000) this.buckets.clear();
  }
}

/** 既定レートルール（02 §11.2 の暫定値）。 */
export const RateRules = {
  register: { limit: 5, windowMs: 60_000 },
  consents: { limit: 10, windowMs: 60_000 },
  deletionRequest: { limit: 10, windowMs: 60_000 },
  authenticatedDefault: { limit: 240, windowMs: 60_000 },
  internalJob: { limit: 60, windowMs: 60_000 },
  uploadInit: { limit: 20, windowMs: 60_000 },
  uploadComplete: { limit: 30, windowMs: 60_000 },
  intakeNextQuestion: { limit: 30, windowMs: 60_000 },
  /** 公開文書・施設検索等の読み取り系。CGNATでIP共有するため余裕を持たせる。 */
  publicRead: { limit: 60, windowMs: 60_000 },
  /** 認証失敗監査の書込上限（トークンSpamによるコスト増幅を抑止）。 */
  authFailAudit: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;
