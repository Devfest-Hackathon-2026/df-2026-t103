import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { healthResponseSchema } from "./apiDocs.js";

/** API-040 / LB・コンテナヘルスチェック用。認証不要。 */
export function registerHealthRoutes(app: FastifyInstance, deps: Deps): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/healthz",
    {
      schema: {
        response: { 200: healthResponseSchema },
        tags: ["ops"],
        summary: "ヘルスチェック",
      },
    },
    async () => ({
      status: "ok",
      service: "mmr-api",
      emulator: deps.config.emulator,
    }),
  );
}
