import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";

/** API-040 / LB・コンテナヘルスチェック用。認証不要。 */
export function registerHealthRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/healthz", async () => ({
    status: "ok",
    service: "mmr-api",
    emulator: deps.config.emulator,
  }));
}
