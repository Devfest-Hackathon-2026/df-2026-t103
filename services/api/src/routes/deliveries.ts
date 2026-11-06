import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { deliveryCreateSchema } from "../domain/schemas.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import { createDelivery, getDeliveryForSender } from "../services/deliveries.js";
import {
  deliveryCreateResponseSchema,
  deliveryGetResponseSchema,
  errors,
} from "./apiDocs.js";

const deliveryIdParam = z.object({ deliveryId: z.string().min(1).max(200) });

/**
 * 配送 API（API-029/030, FR-H05〜H08）。
 * POST /deliveries: 冪等・トランザクション・状態機械 created→delivered→acknowledged/failed/revoked
 */
export function registerDeliveryRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-029 問診票配送（Idempotency-Key 必須）
  typed.post(
    "/v1/deliveries",
    {
      config: { access: { tier: "active" } },
      schema: {
        body: deliveryCreateSchema,
        response: {
          202: deliveryCreateResponseSchema,
          ...errors(400, 401, 403, 409, 412, 429),
        },
        tags: ["deliveries"],
        summary: "問診票を施設へ配送（冪等・トランザクション管理）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const result = await createDelivery(deps, {
        senderUid: uidOf(req),
        body: req.body,
        idempotencyKey: requireIdempotencyKey(req),
        requestId: req.id,
      });
      return reply.status(202).send(result);
    },
  );

  // API-030 配送状況取得（送信者のみ参照可）
  typed.get(
    "/v1/deliveries/:deliveryId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: deliveryIdParam,
        response: {
          200: deliveryGetResponseSchema,
          ...errors(401, 403, 404),
        },
        tags: ["deliveries"],
        summary: "配送状況取得（pending/delivered/failed 区別）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      getDeliveryForSender(deps, {
        senderUid: uidOf(req),
        deliveryId: req.params.deliveryId,
        requestId: req.id,
      }),
  );
}
