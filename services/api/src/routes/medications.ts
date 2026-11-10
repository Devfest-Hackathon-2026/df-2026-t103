import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import {
  medicationCreateSchema,
  medicationPatchSchema,
} from "../domain/schemas.js";
import {
  createMedication,
  deleteMedication,
  getExtraction,
  listMedications,
  patchMedication,
} from "../services/medications.js";
import {
  errors,
  extractionResponseSchema,
  medicationListResponseSchema,
  medicationResponseSchema,
} from "./apiDocs.js";

const jobIdParam = z.object({ jobId: z.string().min(1).max(200) });
const medicationIdParam = z.object({
  medicationId: z.string().min(1).max(200),
});

/**
 * 薬剤 API（API-022〜026, FR-M03〜M07）。
 * OCR候補は本APIの confirm フローでのみ confirmed になる（VAL-013）。
 */
export function registerMedicationRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-022
  typed.get(
    "/v1/medications/extractions/:jobId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: jobIdParam,
        response: {
          200: extractionResponseSchema,
          ...errors(401, 403, 404, 412, 429, 500, 503),
        },
        tags: ["medications"],
        summary: "OCR抽出候補の照会（unconfirmed のまま返却）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      getExtraction(deps, {
        uid: uidOf(req),
        jobId: req.params.jobId,
        requestId: req.requestContext.requestId,
      }),
  );

  // API-023
  typed.post(
    "/v1/medications",
    {
      config: { access: { tier: "active" } },
      schema: {
        body: medicationCreateSchema,
        response: {
          201: medicationResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["medications"],
        summary: "本人確認済み薬剤登録（Idempotency-Key 必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await createMedication(deps, {
        uid: uidOf(req),
        body: req.body,
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
      return reply.status(201).send(result);
    },
  );

  // API-024
  typed.get(
    "/v1/medications",
    {
      config: { access: { tier: "active" } },
      schema: {
        response: {
          200: medicationListResponseSchema,
          ...errors(401, 403, 412, 429, 500, 503),
        },
        tags: ["medications"],
        summary: "薬剤一覧（現在/過去/不明を区別、FR-M05）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => listMedications(deps, uidOf(req)),
  );

  // API-025
  typed.patch(
    "/v1/medications/:medicationId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: medicationIdParam,
        body: medicationPatchSchema,
        response: {
          200: medicationResponseSchema,
          ...errors(400, 401, 403, 404, 412, 429, 500, 503),
        },
        tags: ["medications"],
        summary: "薬剤編集",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      patchMedication(deps, {
        uid: uidOf(req),
        medicationId: req.params.medicationId,
        body: req.body,
        requestId: req.requestContext.requestId,
      }),
  );

  // API-026
  typed.delete(
    "/v1/medications/:medicationId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: medicationIdParam,
        response: {
          204: z.null(),
          ...errors(401, 403, 404, 412, 429, 500, 503),
        },
        tags: ["medications"],
        summary: "薬剤削除",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await deleteMedication(deps, {
        uid: uidOf(req),
        medicationId: req.params.medicationId,
        requestId: req.requestContext.requestId,
      });
      return reply.status(204).send(null);
    },
  );
}
