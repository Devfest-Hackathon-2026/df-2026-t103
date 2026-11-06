import pino from "pino";
import type { Deps } from "../../src/deps.js";
import type { AppConfig } from "../../src/config.js";
import { ManualClock } from "../../src/lib/clock.js";
import { RateLimiter } from "../../src/lib/rateLimit.js";
import { MemoryFirestore } from "./memoryFirestore.js";
import { SignatureContentScanner } from "../../src/lib/contentScan.js";
import { createOcrJobForUpload } from "../../src/services/ocr.js";
import {
  FakeAppCheckVerifier,
  FakeAuthAdmin,
  FakeAuthVerifier,
  FakeLlmAdapter,
  FakeOcrEngine,
  FakeOcrTaskQueue,
  FakePlacesGateway,
  FakeStorageGateway,
} from "./fakes.js";

export { ManualClock };

export interface TestDeps extends Deps {
  memDb: MemoryFirestore;
  clock: ManualClock;
  fakeAuth: FakeAuthVerifier;
  fakeAuthAdmin: FakeAuthAdmin;
  fakeAppCheck: FakeAppCheckVerifier;
  fakeStorage: FakeStorageGateway;
  fakeOcrEngine: FakeOcrEngine;
  fakeOcrQueue: FakeOcrTaskQueue;
  fakeLlm: FakeLlmAdapter;
  fakePlaces: FakePlacesGateway;
}

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    projectId: "demo-mmr-dev",
    storageBucket: "demo-mmr-dev.appspot.com",
    storageEmulatorPublicHost: "localhost:9199",
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
    uploadMaxActive: 20,
    uploadUrlTtlSeconds: 900,
    uploadDocTtlDays: 30,
    ocrMaxAttempts: 3,
    ocrLeaseMs: 300_000,
    ocrTasksLocation: "asia-northeast1",
    ocrTasksQueue: undefined,
    ocrTasksTargetUrl: undefined,
    ocrTasksOidcSa: undefined,
    intakeDraftTtlDays: 7,
    aiIntakeEnabled: false,
    vertexAiApiKey: undefined,
    vertexAiModel: "gemini-2.5-flash-lite",
    vertexAiLocation: "asia-northeast1",
    vertexAiTimeoutMs: 10_000,
    healthzProbeTimeoutMs: 2_000,
    healthzProbeCacheMs: 5_000,
    googlePlacesApiKey: undefined,
    placesMaxResults: 10,
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
  const fakeStorage = new FakeStorageGateway();
  const fakeOcrEngine = new FakeOcrEngine();
  const fakeOcrQueue = new FakeOcrTaskQueue();
  const fakeLlm = new FakeLlmAdapter();
  const fakePlaces = new FakePlacesGateway();
  const logger = pino({ level: "silent" });

  const deps: TestDeps = {
    config,
    db: memDb.asFirestore(),
    memDb,
    auth: fakeAuth,
    authAdmin: fakeAuthAdmin,
    appCheck: fakeAppCheck,
    storage: fakeStorage,
    contentScanner: new SignatureContentScanner(),
    ocrEngine: fakeOcrEngine,
    ocrQueue: fakeOcrQueue,
    llmAdapter: fakeLlm,
    placesGateway: fakePlaces,
    rateLimiter: new RateLimiter(clock),
    clock,
    logger,
    fakeAuth,
    fakeAuthAdmin,
    fakeAppCheck,
    fakeStorage,
    fakeOcrEngine,
    fakeOcrQueue,
    fakeLlm,
    fakePlaces,
  };
  deps.uploadCompletion = {
    onUploadCompleted: async (p) => {
      await createOcrJobForUpload(deps, p);
    },
  };
  return deps;
}
