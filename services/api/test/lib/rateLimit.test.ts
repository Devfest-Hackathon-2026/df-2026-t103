import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/lib/rateLimit.js";
import { ApiError } from "../../src/lib/errors.js";
import { ManualClock } from "../../src/lib/clock.js";

describe("RateLimiter", () => {
  it("制限内は消費でき、超過で 429", () => {
    const clock = new ManualClock(new Date("2026-01-01T00:00:00Z"));
    const rl = new RateLimiter(clock);
    const rule = { limit: 3, windowMs: 60_000 };
    rl.consume("k", rule);
    rl.consume("k", rule);
    rl.consume("k", rule);
    try {
      rl.consume("k", rule);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(429);
      expect((e as ApiError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("別キーは独立してカウントされる", () => {
    const clock = new ManualClock(new Date());
    const rl = new RateLimiter(clock);
    const rule = { limit: 1, windowMs: 60_000 };
    rl.consume("a", rule);
    expect(() => rl.consume("b", rule)).not.toThrow();
  });

  it("ウィンドウ経過後はリセットされる", () => {
    const clock = new ManualClock(new Date());
    const rl = new RateLimiter(clock);
    const rule = { limit: 1, windowMs: 1_000 };
    rl.consume("k", rule);
    clock.advanceMs(1_001);
    expect(() => rl.consume("k", rule)).not.toThrow();
  });
});
