import { describe, expect, it } from "vitest";
import { runIdempotent, requestHash } from "../../src/lib/idempotency.js";
import { ApiError } from "../../src/lib/errors.js";
import { makeTestDeps } from "../helpers/deps.js";

describe("runIdempotent", () => {
  it("初回は実行され、同一キー+同一本文は結果を再生する", async () => {
    const deps = makeTestDeps();
    let calls = 0;
    const params = {
      namespace: "test",
      key: "key-1",
      principal: "uid-1",
      requestHash: requestHash(deps, { a: 1 }),
      execute: async () => {
        calls += 1;
        return { value: "ok" } as Record<string, unknown>;
      },
    };
    const first = await runIdempotent(deps, params);
    const second = await runIdempotent(deps, params);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ value: "ok" });
    expect(calls).toBe(1);
  });

  it("同一キー+異なる本文は 409 IDEMPOTENCY_CONFLICT", async () => {
    const deps = makeTestDeps();
    await runIdempotent(deps, {
      namespace: "test",
      key: "key-1",
      principal: "uid-1",
      requestHash: requestHash(deps, { a: 1 }),
      execute: async () => ({}),
    });
    try {
      await runIdempotent(deps, {
        namespace: "test",
        key: "key-1",
        principal: "uid-1",
        requestHash: requestHash(deps, { a: 2 }),
        execute: async () => ({}),
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("別プリンシパルの同一キーは衝突しない", async () => {
    const deps = makeTestDeps();
    const body = requestHash(deps, { a: 1 });
    await runIdempotent(deps, {
      namespace: "test",
      key: "key-1",
      principal: "uid-1",
      requestHash: body,
      execute: async () => ({ n: 1 }),
    });
    const r = await runIdempotent(deps, {
      namespace: "test",
      key: "key-1",
      principal: "uid-2",
      requestHash: body,
      execute: async () => ({ n: 2 }),
    });
    expect(r.result).toEqual({ n: 2 });
  });
});
