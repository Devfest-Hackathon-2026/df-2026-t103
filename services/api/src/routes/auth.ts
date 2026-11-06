import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import { RateRules } from "../lib/rateLimit.js";
import { registerBodySchema } from "../domain/schemas.js";
import { registerEmail } from "../services/registration.js";
import { errors, registerResponseSchema } from "./apiDocs.js";

/** API-041 メール新規登録（ID token不要・App Check+レート制限+同意検証）。 */
export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/auth/register",
    {
      config: {
        access: { tier: "public", rateRule: RateRules.register },
      },
      schema: {
        body: registerBodySchema,
        response: {
          201: registerResponseSchema,
          ...errors(400, 409, 412, 429, 500),
        },
        tags: ["auth"],
        summary: "メール新規登録（Idempotency-Key 必須）",
      },
    },
    async (req, reply) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await registerEmail(deps, {
        body: req.body,
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
      return reply.status(201).send(result);
    },
  );
}
