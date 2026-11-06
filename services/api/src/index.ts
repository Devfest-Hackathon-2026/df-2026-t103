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
import { CloudTasksOcrQueue } from "./tasks.js";
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
