import pino from "pino";
import { FieldValue } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { loggerOptions } from "./logger.js";
import { initFirebase } from "./firebase.js";
import { buildApp } from "./app.js";
import type { Deps } from "./deps.js";
import { systemClock } from "./lib/clock.js";
import { RateLimiter } from "./lib/rateLimit.js";
import { AdminAuthVerifier, createAppCheckVerifier } from "./auth/verifiers.js";
import { createStorageGateway } from "./storage.js";
import { SignatureContentScanner } from "./lib/contentScan.js";
import { DummyOcrEngine } from "./engines/dummyOcr.js";
import { DummyLlmAdapter } from "./engines/dummyLlm.js";
import { VertexAiLlmAdapter } from "./engines/vertexLlm.js";
import { CloudTasksOcrQueue } from "./tasks.js";
import { GooglePlacesGateway } from "./engines/googlePlaces.js";
import { DummyPlacesGateway } from "./engines/dummyPlaces.js";
import { AdminPushGateway, DisabledPushGateway } from "./push.js";
import { getMessaging } from "firebase-admin/messaging";
import { createOcrJobForUpload } from "./services/ocr.js";
import { OcrWorker } from "./workers/ocrJob.js";
import { DEV_LEGAL_DOCUMENTS } from "./domain/legalDocuments.js";

/** エミュレータ環境で appConfigs/publicLegalVersion が無ければ開発用文書をシードする。 */
async function seedDevLegalDocuments(deps: Deps): Promise<void> {
  const ref = deps.db.doc("appConfigs/publicLegalVersion");
  const snap = await ref.get();
  if (snap.exists) return;
  await ref.set({
    ...DEV_LEGAL_DOCUMENTS,
    updatedAt: FieldValue.serverTimestamp(),
  });
  deps.logger.warn(
    "seeded dev legal documents into appConfigs/publicLegalVersion (emulator only)",
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(loggerOptions(config)) as pino.Logger;
  const firebase = initFirebase(config);

  const deps: Deps = {
    config,
    db: firebase.firestore,
    auth: new AdminAuthVerifier(firebase.auth),
    authAdmin: firebase.auth,
    appCheck: createAppCheckVerifier(config, firebase.appCheck),
    storage: createStorageGateway(firebase.storage, config),
    contentScanner: new SignatureContentScanner(),
    ocrEngine: new DummyOcrEngine(),
    // エミュレータは同プロセス内で即時実行、本番は Cloud Tasks
    ocrQueue: config.emulator
      ? {
          enqueueOcrJob: async (jobId) => {
            await new OcrWorker(deps).runJob(jobId);
          },
        }
      : new CloudTasksOcrQueue(config),
    // APIキーが未注入（Secret Manager未設定）の環境ではdummy。
    // aiIntakeEnabled=false 既定では呼ばれず、呼ばれても固定質問へ戻る。
    llmAdapter:
      config.vertexAiApiKey !== undefined && config.vertexAiApiKey !== ""
        ? new VertexAiLlmAdapter({
            apiKey: config.vertexAiApiKey,
            model: config.vertexAiModel,
            location: config.vertexAiLocation,
            projectId: config.projectId,
            timeoutMs: config.vertexAiTimeoutMs,
          })
        : new DummyLlmAdapter(),
    placesGateway:
      config.googlePlacesApiKey !== undefined && config.googlePlacesApiKey !== ""
        ? new GooglePlacesGateway(config.googlePlacesApiKey)
        : new DummyPlacesGateway(),
    // FCMはエミュレートされない。開発/エミュレータは送信無効（disabled で
    // トークン保持・監査記録なし）、本番のみ Admin SDK で送信する。
    pushGateway: config.emulator
      ? new DisabledPushGateway(logger)
      : new AdminPushGateway(getMessaging(firebase.app)),
    rateLimiter: new RateLimiter(systemClock),
    clock: systemClock,
    logger,
  };
  deps.uploadCompletion = {
    onUploadCompleted: async (p) => {
      await createOcrJobForUpload(deps, p);
    },
  };

  if (config.emulator) {
    await seedDevLegalDocuments(deps).catch((err) =>
      logger.warn({ err }, "dev legal document seed skipped"),
    );
  }

  const app = buildApp(deps);
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal startup error", err);
  process.exit(1);
});
