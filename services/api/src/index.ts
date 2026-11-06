import pino from "pino";
import { loadConfig } from "./config.js";
import { loggerOptions } from "./logger.js";
import { initFirebase } from "./firebase.js";
import { buildApp } from "./app.js";
import type { Deps } from "./deps.js";
import { systemClock } from "./lib/clock.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(loggerOptions(config)) as pino.Logger;
  const firebase = initFirebase(config);

  const deps: Deps = {
    config,
    db: firebase.firestore,
    clock: systemClock,
    logger,
  };

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
