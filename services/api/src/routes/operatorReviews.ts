import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { requireFreshAuth, requirePlatformSecurityAdmin } from "../auth/gates.js";
import { REVIEW_STATUSES } from "../domain/facilityReview.js";
import { listOperatorFacilities, listOperatorVerificationRecords, rejectFacility } from "../services/facilityReviews.js";
import { errors } from "./apiDocs.js";

const params = z.object({ facilityId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) });
const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).max(2100).optional() }).strict();
const checks = z.object({ existence: z.boolean(), applicant: z.boolean(), receiverContact: z.boolean(), location: z.boolean() }).strict();

export function registerOperatorReviewRoutes(app: FastifyInstance, deps: Deps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    config: { access: { tier: "authenticated" as const } },
    onRequest: async (_req: unknown, reply: FastifyReply) => { void reply.header("Cache-Control", "private, no-store"); },
  };
  typed.get("/v1/operator/facilities", {
    ...common,
    schema: {
      querystring: query,
      response: { 200: z.object({ items: z.array(z.object({ facilityId: z.string(), legalName: z.string(), displayName: z.string(), verificationStatus: z.enum(REVIEW_STATUSES), receivingEnabled: z.boolean(), createdAt: z.string().nullable() })), nextCursor: z.string().nullable() }), ...errors(400, 401, 403, 429) },
      tags: ["operator"], summary: "施設審査一覧（非公開連絡先・PHIを除外）", security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    await requirePlatformSecurityAdmin(deps, req);
    return listOperatorFacilities(deps, { operatorUid: req.requestContext.auth!.uid, limit: req.query.limit, ...(req.query.cursor ? { cursor: req.query.cursor } : {}), requestId: req.id });
  });
  typed.get("/v1/operator/facilities/:facilityId/verification-records", {
    ...common,
    schema: {
      params, querystring: query,
      response: { 200: z.object({ items: z.array(z.object({ recordId: z.string(), decision: z.enum(["verified", "rejected"]), checks, createdAt: z.string().nullable() })), nextCursor: z.string().nullable() }), ...errors(400, 401, 403, 404, 429) },
      tags: ["operator"], summary: "施設検証証跡のサマリー（自由記述・免許番号・審査者UIDを除外）", security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    await requirePlatformSecurityAdmin(deps, req);
    return listOperatorVerificationRecords(deps, { facilityId: req.params.facilityId, operatorUid: req.requestContext.auth!.uid, limit: req.query.limit, ...(req.query.cursor ? { cursor: req.query.cursor } : {}), requestId: req.id });
  });
  typed.post("/v1/operator/facilities/:facilityId/reject", {
    ...common,
    schema: {
      params,
      body: z.object({ checks, verificationRecordId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500) }).strict(),
      response: { 200: z.object({ facilityId: z.string(), verificationStatus: z.literal("rejected") }), ...errors(400, 401, 403, 404, 409, 429) },
      tags: ["operator"], summary: "未審査施設の却下（証跡・再認証必須）", security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    await requirePlatformSecurityAdmin(deps, req);
    requireFreshAuth(deps, req);
    return rejectFacility(deps, { ...req.body, facilityId: req.params.facilityId, operatorUid: req.requestContext.auth!.uid, requestId: req.id });
  });
}
