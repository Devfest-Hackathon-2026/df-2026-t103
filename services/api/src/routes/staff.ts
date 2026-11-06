import { Timestamp } from "firebase-admin/firestore";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { requireFacilityRole, requireFreshAuth } from "../auth/gates.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import {
  auditInTransaction,
  auditResourceHash,
  auditUidHash,
  logAuditEvent,
} from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import type { AuditEventDoc } from "../domain/firestoreDocs.js";
import { hmacParts } from "../lib/hash.js";
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
    // facility+email から導出する決定的IDにし、tx 内の get でユニーク性を検証する
    // （tx 外の事前クエリだけでは同時招待で重複 pending が作られ得る）
    const invitationId = `inv_${hmacParts(
      deps.config.hmacSecret,
      "invite",
      req.params.facilityId,
      email,
    ).slice(0, 32)}`;
    const actorUid = req.requestContext.auth!.uid;
    const committedAudits: AuditEventDoc[] = [];
    await deps.db.runTransaction(async (tx) => {
      // tx リトライ時にロールバック済みイベントが残らないよう各試行でリセット
      committedAudits.length = 0;
      const ref = deps.db.doc(`facilityInvitations/${invitationId}`);
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { status?: string }).status === "pending") {
        throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "このメールアドレスへの招待は保留中です。");
      }
      // 過去の招待（accepted/revoked 等）があれば pending に戻して再招待する
      tx.set(ref, {
        facilityId: req.params.facilityId,
        email,
        role: req.body.role,
        status: "pending",
        invitedByUid: actorUid,
        createdAt: Timestamp.fromDate(deps.clock.now()),
      });
      committedAudits.push(
        auditInTransaction(tx, deps, {
          actorType: "staff", actorUidHash: auditUidHash(deps, actorUid),
          action: AUDIT_ACTIONS.STAFF_INVITED, resourceType: "facilityInvitation",
          resourceIdHash: auditResourceHash(deps, invitationId),
          facilityId: req.params.facilityId, requestId: req.id, decision: "allow",
        }),
      );
    });
    for (const e of committedAudits) logAuditEvent(deps, e);
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
    const committedAudits: AuditEventDoc[] = [];
    const result = await deps.db.runTransaction(async (tx) => {
      committedAudits.length = 0;
      const ref = deps.db.doc(`facilityMemberships/${req.params.membershipId}`);
      const snapshot = await tx.get(ref);
      const member = snapshot.data() as { facilityId?: string; userUid?: string; role?: string; status?: string } | undefined;
      if (!member || member.facilityId !== req.params.facilityId) throw ApiError.notFound();
      if (member.userUid === actorUid && (req.body.status === "revoked" || (req.body.role && req.body.role !== "facility_admin"))) {
        throw ApiError.forbidden("自身の管理者権限は変更できません。");
      }
      const role = req.body.role ?? member.role;
      const status = req.body.status ?? member.status;
      if (!staffRole.safeParse(role).success || (status !== "active" && status !== "revoked")) {
        // 保存済みデータが不正（権限不足ではなくデータ不整合）
        throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "メンバーシップの状態が不正です。");
      }
      const isRevokeTransition = status === "revoked" && member.status !== "revoked";
      // 変更がない PATCH は更新も監査も発行しない（遷移なし＝監査なし）
      if (role !== member.role || status !== member.status) {
        tx.update(ref, {
          role,
          status,
          // revokedAt は失効遷移時のみ打刻し、active へ戻す時はクリアする
          ...(isRevokeTransition
            ? { revokedAt: Timestamp.fromDate(deps.clock.now()) }
            : status === "active"
              ? { revokedAt: null }
              : {}),
        });
        committedAudits.push(
          auditInTransaction(tx, deps, {
            actorType: "staff", actorUidHash: auditUidHash(deps, actorUid),
            action: isRevokeTransition
              ? AUDIT_ACTIONS.MEMBERSHIP_REVOKED
              : AUDIT_ACTIONS.STAFF_MEMBERSHIP_UPDATED,
            resourceType: "facilityMembership",
            resourceIdHash: auditResourceHash(deps, req.params.membershipId),
            facilityId: req.params.facilityId, requestId: req.id, decision: "allow",
            details: { role: role as string, status: status as string },
          }),
        );
      }
      return { membershipId: req.params.membershipId, role: role as z.infer<typeof staffRole>, status: status as "active" | "revoked" };
    });
    for (const e of committedAudits) logAuditEvent(deps, e);
    return result;
  });
}
