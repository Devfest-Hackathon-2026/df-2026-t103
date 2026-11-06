import { describe, expect, it } from "vitest";
import pino from "pino";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import type { Deps } from "../../src/deps.js";
import { systemClock } from "../../src/lib/clock.js";

function makeDeps(): Deps {
  const config: AppConfig = {
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    projectId: "demo-mmr-dev",
    storageBucket: "demo-mmr-dev.appspot.com",
    databaseUrl: undefined,
    emulator: true,
    hmacSecret: "test-hmac-secret",
    appCheckMode: "permissive",
    internalJobToken: "test-internal-token",
    reauthWindowSeconds: 900,
    deletionGracePeriodDays: 30,
    deletionJobMaxAttempts: 5,
    deletionScanBatchSize: 100,
  };
  return {
    config,
    db: {} as Deps["db"],
    clock: systemClock,
    logger: pino({ level: "silent" }),
  };
}

describe("GET /healthz", () => {
  it("200 を返す（認証不要）", async () => {
    const app = buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });
});
