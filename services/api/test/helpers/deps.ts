import pino from "pino";
import type { Deps } from "../../src/deps.js";
import type { AppConfig } from "../../src/config.js";
import { ManualClock } from "../../src/lib/clock.js";
import { RateLimiter } from "../../src/lib/rateLimit.js";
import { MemoryFirestore } from "./memoryFirestore.js";
import {
  FakeAppCheckVerifier,
  FakeAuthAdmin,
  FakeAuthVerifier,
  FakeStorageDeleter,
} from "./fakes.js";

export { ManualClock };

export interface TestDeps extends Deps {
  memDb: MemoryFirestore;
  clock: ManualClock;
  fakeAuth: FakeAuthVerifier;
  fakeAuthAdmin: FakeAuthAdmin;
  fakeAppCheck: FakeAppCheckVerifier;
  fakeStorage: FakeStorageDeleter;
}

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
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
    apiDocsEnabled: true,
    reauthWindowSeconds: 900,
    deletionGracePeriodDays: 30,
    deletionJobMaxAttempts: 5,
    deletionScanBatchSize: 100,
    ...overrides,
  });
}

export function makeTestDeps(
  configOverrides: Partial<AppConfig> = {},
): TestDeps {
  const config = makeTestConfig(configOverrides);
  const memDb = new MemoryFirestore();
  const clock = new ManualClock(new Date());
  const fakeAuth = new FakeAuthVerifier();
  const fakeAuthAdmin = new FakeAuthAdmin();
  const fakeAppCheck = new FakeAppCheckVerifier();
  const fakeStorage = new FakeStorageDeleter();
  const logger = pino({ level: "silent" });

  return {
    config,
    db: memDb.asFirestore(),
    memDb,
    auth: fakeAuth,
    authAdmin: fakeAuthAdmin,
    appCheck: fakeAppCheck,
    storage: fakeStorage,
    rateLimiter: new RateLimiter(clock),
    clock,
    logger,
    fakeAuth,
    fakeAuthAdmin,
    fakeAppCheck,
    fakeStorage,
  };
}
