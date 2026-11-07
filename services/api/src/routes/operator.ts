import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { AUDIT_ACTIONS, SUMMARY_ACTORS, SUMMARY_OUTCOMES } from "../domain/auditEvents.js";
import {
  requireFreshAuth,
  requirePlatformSecurityAdmin,
} from "../auth/gates.js";
import {
  disableFacilityReceiving,
  listJobFailures,
  listOperatorAuditEvents,
  verifyFacility,
} from "../services/operator.js";
import { errors } from "./apiDocs.js";

const facilityParams = z.object({
  facilityId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
});

/** FR-H04: 4検証項目は承認に全て必須。 */
const verifyBody = z.object({
  checks: z
    .object({
      existence: z.boolean(),
      applicant: z.boolean(),
      receiverContact: z.boolean(),
      location: z.boolean(),
    })
    .refine(
      (c) => c.existence && c.applicant && c.receiverContact && c.location,
      { message: "verification requires all four checks" },
    ),
  verificationRecordId: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

const disableBody = z.object({
  reason: z.string().min(1).max(500),
});

const jobFailuresQuery = z.object({
  type: z.enum(["ocr", "deletion"]),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // 不透明カーソルは base64url(28B + docパス)。FirestoreのdocId上限
  // (1500B)まで発行したカーソルが受理されるよう余裕を持たせる
  cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).max(2100).optional(),
});

const jobFailureItemSchema = z.object({
  type: z.enum(["ocr", "deletion"]),
  jobId: z.string(),
  failureCode: z.string().nullable(),
  attempts: z.number(),
  failedAt: z.string().nullable(),
});

export function registerOperatorRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/v1/operator/audit-events",
    {
      config: { access: { tier: "authenticated" } },
      onRequest: async (_req, reply) => {
        void reply.header("Cache-Control", "private, no-store");
      },
      schema: {
        querystring: jobFailuresQuery.omit({ type: true }).strict(),
        response: {
          200: z.object({
            items: z.array(z.object({
              eventId: z.string().regex(/^ae_[0-9a-f]{64}$/),
              action: z.enum([...Object.values(AUDIT_ACTIONS), "UNKNOWN"]),
              actorType: z.enum(SUMMARY_ACTORS),
              occurredAt: z.string().nullable(),
              decision: z.enum(["allow", "deny"]).nullable(),
              outcome: z.enum(SUMMARY_OUTCOMES).nullable(),
            })),
            nextCursor: z.string().nullable(),
          }),
          ...errors(400, 401, 403, 429),
        },
        tags: ["operator"],
        summary: "監査イベントの非識別サマリー（O-002）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requirePlatformSecurityAdmin(deps, req);
      return listOperatorAuditEvents(deps, {
        operatorUid: req.requestContext.auth!.uid,
        limit: req.query.limit,
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
        requestId: req.id,
      });
    },
  );

  // API-036 施設本人確認承認（platform_security_admin + 再認証）
  typed.post(
    "/v1/operator/facilities/:facilityId/verify",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: facilityParams,
        body: verifyBody,
        response: {
          200: z.object({
            facilityId: z.string(),
            verificationStatus: z.literal("verified"),
            verifiedAt: z.string(),
          }),
          ...errors(400, 401, 403, 404, 409, 429),
        },
        tags: ["operator"],
        summary: "施設本人確認承認（検証証跡必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requirePlatformSecurityAdmin(deps, req);
      requireFreshAuth(deps, req);
      return verifyFacility(deps, {
        facilityId: req.params.facilityId,
        operatorUid: req.requestContext.auth!.uid,
        checks: req.body.checks,
        verificationRecordId: req.body.verificationRecordId,
        ...(req.body.note !== undefined ? { note: req.body.note } : {}),
        requestId: req.id,
      });
    },
  );

  // API-037 施設受付の緊急停止（platform_security_admin + 再認証）
  typed.post(
    "/v1/operator/facilities/:facilityId/disable",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: facilityParams,
        body: disableBody,
        response: {
          200: z.object({
            facilityId: z.string(),
            receivingEnabled: z.literal(false),
          }),
          ...errors(400, 401, 403, 404, 429),
        },
        tags: ["operator"],
        summary: "施設受付の緊急停止",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requirePlatformSecurityAdmin(deps, req);
      requireFreshAuth(deps, req);
      return disableFacilityReceiving(deps, {
        facilityId: req.params.facilityId,
        operatorUid: req.requestContext.auth!.uid,
        reason: req.body.reason,
        requestId: req.id,
      });
    },
  );

  // API-038 失敗ジョブ一覧（PII非表示・platform_security_admin）
  typed.get(
    "/v1/operator/job-failures",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        querystring: jobFailuresQuery,
        response: {
          200: z.object({
            items: z.array(jobFailureItemSchema),
            nextCursor: z.string().nullable(),
          }),
          ...errors(400, 401, 403, 429),
        },
        tags: ["operator"],
        summary: "失敗ジョブ一覧（PII非表示）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requirePlatformSecurityAdmin(deps, req);
      return listJobFailures(deps, {
        type: req.query.type,
        operatorUid: req.requestContext.auth!.uid,
        ...(req.query.cursor !== undefined
          ? { cursor: req.query.cursor }
          : {}),
        limit: req.query.limit,
        requestId: req.id,
      });
    },
  );
}
