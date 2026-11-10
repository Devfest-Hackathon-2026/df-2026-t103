import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { startSyntheticDemo } from "../services/syntheticDemo.js";
import { errors } from "./apiDocs.js";

export function registerSyntheticDemoRoutes(app: FastifyInstance, deps: Deps): void {
  app.withTypeProvider<ZodTypeProvider>().post("/v1/me/synthetic-demo", {
    config: { access: { tier: "active", rateRule: { limit: 5, windowMs: 60_000 } } },
    schema: {
      body: z.object({ syntheticDataOnly: z.literal(true) }).strict(),
      response: { 200: z.object({ facilityId: z.string(), syntheticRecipient: z.literal(true),
        verificationStatus: z.literal("pending"), mode: z.literal("storage_only"), hospitalViewing: z.literal("unconfirmed") }),
        ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503) },
      tags: ["facilities"], summary: "本人専用の合成デモ開始（送信保存のみ）", security: [{ bearerAuth: [] }],
    },
  }, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const auth = req.requestContext.auth!;
    return startSyntheticDemo(deps, auth.uid, auth.emailVerified === true);
  });
}
