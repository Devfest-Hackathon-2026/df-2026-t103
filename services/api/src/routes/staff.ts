import { Timestamp } from "firebase-admin/firestore";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { requireFacilityRole, requireFreshAuth } from "../auth/gates.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { auditInTransaction, auditResourceHash, auditUidHash } from "../lib/audit.js";
import { randomId } from "../lib/hash.js";
import { queryDocs } from "../repos/helpers.js";
import { errors } from "./apiDocs.js";

const params = z.object({ facilityId: z.string().min(1).max(200) });
const memberParams = params.extend({ membershipId: z.string().min(1).max(200) });
const staffRole = z.enum(["facility_staff", "facility_clinician", "facility_admin"]);
const invitationBody = z.object({ email: z.email(), role: staffRole });
const membershipBody = z.object({ role: staffRole.optional(), status: z.enum(["active", "revoked"]).optional() })
  .refine((value) => value.role !== undefined || value.status !== undefined);

export function registerStaffRoutes(app: FastifyInstance, deps: Deps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post("/v1/hospitals/:facilityId/staff-invitations", {
    config: { access: { tier: "authenticated" } },
    schema: {
      params,
      body: invitationBody,
      response: { 201: z.object({ invitationId: z.string(), status: z.literal("pending") }), ...errors(401, 403, 409) },
      tags: ["hospitals"],
      security: [{ bearerAuth: [] }],
    },
  }, async (req, reply) => {
    await requireFacilityRole(deps, req, req.params.facilityId, ["facility_admin"]);
    requireFreshAuth(deps, req);
    const email = req.body.email.trim().toLowerCase();
    const existing = await queryDocs<{ status: string }>(deps.db, "facilityInvitations", [
      { field: "facilityId", op: "==", value: req.params.facilityId },
      { field: "email", op: "==", value: email },
      { field: "status", op: "==", value: "pending" },
    ], { limit: 1 });
    if (existing.length) throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "このメールアドレスへの招待は保留中です。");
    const invitationId = randomId("inv");
    const actorUid = req.requestContext.auth!.uid;
    await deps.db.runTransaction(async (tx) => {
      tx.create(deps.db.doc(`facilityInvitations/${invitationId}`), {
        facilityId: req.params.facilityId,
        email,
        role: req.body.role,
        status: "pending",
        invitedByUid: actorUid,
        createdAt: Timestamp.fromDate(deps.clock.now()),
      });
      auditInTransaction(tx, deps, {
        actorType: "staff", actorUidHash: auditUidHash(deps, actorUid),
        action: "staff.invite", resourceType: "facilityInvitation",
        resourceIdHash: auditResourceHash(deps, invitationId),
        facilityId: req.params.facilityId, requestId: req.id, decision: "allow",
      });
    });
    return reply.code(201).send({ invitationId, status: "pending" as const });
  });

  typed.patch("/v1/hospitals/:facilityId/memberships/:membershipId", {
    config: { access: { tier: "authenticated" } },
    schema: {
      params: memberParams,
      body: membershipBody,
      response: { 200: z.object({ membershipId: z.string(), role: staffRole, status: z.enum(["active", "revoked"]) }), ...errors(401, 403, 404, 409) },
      tags: ["hospitals"],
      security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    await requireFacilityRole(deps, req, req.params.facilityId, ["facility_admin"]);
    requireFreshAuth(deps, req);
    const actorUid = req.requestContext.auth!.uid;
    const result = await deps.db.runTransaction(async (tx) => {
      const ref = deps.db.doc(`facilityMemberships/${req.params.membershipId}`);
      const snapshot = await tx.get(ref);
      const member = snapshot.data() as { facilityId?: string; userUid?: string; role?: string; status?: string } | undefined;
      if (!member || member.facilityId !== req.params.facilityId) throw ApiError.notFound();
      if (member.userUid === actorUid && (req.body.status === "revoked" || (req.body.role && req.body.role !== "facility_admin"))) {
        throw ApiError.forbidden("自身の管理者権限は変更できません。");
      }
      const role = req.body.role ?? member.role;
      const status = req.body.status ?? member.status;
      if (!staffRole.safeParse(role).success || (status !== "active" && status !== "revoked")) throw ApiError.forbidden();
      tx.update(ref, {
        role,
        status,
        ...(status === "revoked" ? { revokedAt: Timestamp.fromDate(deps.clock.now()) } : {}),
      });
      auditInTransaction(tx, deps, {
        actorType: "staff", actorUidHash: auditUidHash(deps, actorUid),
        action: "staff.membership.update", resourceType: "facilityMembership",
        resourceIdHash: auditResourceHash(deps, req.params.membershipId),
        facilityId: req.params.facilityId, requestId: req.id, decision: "allow",
      });
      return { membershipId: req.params.membershipId, role: role as z.infer<typeof staffRole>, status: status as "active" | "revoked" };
    });
    return result;
  });
}
