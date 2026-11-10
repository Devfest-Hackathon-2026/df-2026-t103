import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import {
  emptyBodySchema,
  uploadInitBodySchema,
} from "../domain/schemas.js";
import { assertParsed } from "../lib/errors.js";
import { RateRules } from "../lib/rateLimit.js";
import {
  completeUpload,
  getUploadProcessing,
  initUpload,
} from "../services/uploads.js";
import {
  errors,
  uploadCompleteResponseSchema,
  uploadInitResponseSchema,
  uploadProcessingResponseSchema,
} from "./apiDocs.js";

/**
 * 画像アップロード API（API-019〜021, FR-M01）。
 * 署名URLは所有者スコープの objectPath に限定し、complete 時に実オブジェクトを
 * サーバ側で検証する（クライアント申告を信用しない、04 §7.3）。
 */
export function registerUploadRoutes(app: FastifyInstance, deps: Deps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-019
  typed.post(
    "/v1/uploads/init",
    {
      config: {
        access: { tier: "active", rateRule: RateRules.uploadInit },
      },
      schema: {
        body: uploadInitBodySchema,
        response: {
          201: uploadInitResponseSchema,
          ...errors(400, 401, 403, 409, 412, 413, 429, 500, 503),
        },
        tags: ["uploads"],
        summary: "アップロード開始（短命署名URL発行・Idempotency-Key 必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await initUpload(deps, {
        uid: uidOf(req),
        body: req.body,
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
      return reply.status(201).send(result);
    },
  );

  // API-020
  typed.post(
    "/v1/uploads/:uploadId/complete",
    {
      config: {
        access: { tier: "active", rateRule: RateRules.uploadComplete },
      },
      schema: {
        params: z.object({ uploadId: z.string().min(1).max(200) }),
        body: emptyBodySchema.nullish(),
        response: {
          200: uploadCompleteResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 413, 429, 500, 503),
        },
        tags: ["uploads"],
        summary: "アップロード完了（サーバ側で実オブジェクトを検証）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      assertParsed(emptyBodySchema.safeParse(req.body ?? {}));
      const idempotencyKey = requireIdempotencyKey(req);
      return completeUpload(deps, {
        uid: uidOf(req),
        uploadId: req.params.uploadId,
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
    },
  );

  // API-021
  typed.get(
    "/v1/uploads/:uploadId/processing",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: z.object({ uploadId: z.string().min(1).max(200) }),
        response: {
          200: uploadProcessingResponseSchema,
          ...errors(401, 403, 404, 412, 429, 500, 503),
        },
        tags: ["uploads"],
        summary: "OCR処理状態の照会（非PHIステータスのみ返却）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      getUploadProcessing(deps, {
        uid: uidOf(req),
        uploadId: req.params.uploadId,
      }),
  );
}
