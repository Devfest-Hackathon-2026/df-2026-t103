import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildTestApp } from "../helpers/app.js";
import { makeTestDeps } from "../helpers/deps.js";

const origin = "http://localhost:5050";
const localEmulators = {
  FIREBASE_PROJECT_ID: "demo-mmr-dev",
  FIRESTORE_EMULATOR_HOST: "localhost:8081",
  FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "localhost:9199",
  FIREBASE_DATABASE_EMULATOR_HOST: "localhost:9000",
};
const preflight = {
  origin,
  "access-control-request-method": "POST",
  "access-control-request-headers": "Authorization, Content-Type, X-Firebase-AppCheck, Idempotency-Key, X-Request-Id",
};

describe("CORS", () => {
  it("許可された preflight は認証せず 204 を返し credentials を許可しない", async () => {
    const app = buildTestApp(makeTestDeps({ corsOrigins: [origin], appCheckMode: "enforce" }));
    const res = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: preflight });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, DELETE");
    expect(res.headers["access-control-allow-headers"]).toContain("idempotency-key");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toContain("Origin");
    expect(res.headers.vary).toContain("Access-Control-Request-Headers");
    await app.close();
  });

  it.each([
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "http://localhost:5050.evil.example" },
    { origin: "http://localhost:5050/" },
    { "access-control-request-method": "PUT" },
    { "access-control-request-method": "OPTIONS" },
    { "access-control-request-headers": "authorization, x-internal-job-token" },
    { "access-control-request-headers": "authorization, " },
  ])("不正な preflight を拒否する: %o", async (override) => {
    const app = buildTestApp(makeTestDeps({ corsOrigins: [origin] }));
    const res = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: { ...preflight, ...override } });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers.vary).toContain("Access-Control-Request-Method");
    await app.close();
  });

  it("通常リクエストでは認証と App Check を引き続き要求する", async () => {
    const app = buildTestApp(makeTestDeps({ corsOrigins: [origin], appCheckMode: "enforce" }));
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: { origin } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    const untrusted = await app.inject({ method: "GET", url: "/v1/me", headers: { origin: "https://evil.example" } });
    expect(untrusted.statusCode).toBe(401);
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
    expect(untrusted.headers.vary).toContain("Origin");
    const options = await app.inject({ method: "OPTIONS", url: "/v1/me" });
    expect(options.statusCode).toBe(403);
    await app.close();
  });

  it("設定ごとに許可元を切り替え、production は明示設定なしで拒否", async () => {
    expect(loadConfig({ ...localEmulators, NODE_ENV: "development" }).corsOrigins).toEqual([origin, "http://127.0.0.1:5050"]);
    const production = loadConfig({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "test-project", SERVER_HMAC_SECRET: "test-secret" });
    expect(production.corsOrigins).toEqual([]);
    expect(() => loadConfig({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "test-project", SERVER_HMAC_SECRET: "test-secret", API_CORS_ORIGINS: "http://example.com" })).toThrow("API_CORS_ORIGINS");
    const configured = loadConfig({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "test-project", SERVER_HMAC_SECRET: "test-secret", API_CORS_ORIGINS: "https://app.example, https://other.example" });
    const app = buildTestApp(makeTestDeps({ corsOrigins: configured.corsOrigins }));
    const denied = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: preflight });
    const allowed = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: { ...preflight, origin: "https://app.example" } });
    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(204);
    await app.close();
    expect(loadConfig({ ...localEmulators, API_CORS_ORIGINS: "" }).corsOrigins).toEqual([]);
  });

  it.each(["*", "null", "https://example.com/", "https://example.com/path", "https://user@example.com", "https://example.com,", "https://EXAMPLE.com"])("不正な設定 %s は起動時に拒否", (value) => {
    expect(() => loadConfig({ ...localEmulators, API_CORS_ORIGINS: value })).toThrow("API_CORS_ORIGINS");
  });
});
