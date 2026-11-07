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

function toIsoLocal(ts: unknown): string | null {
  if (
    typeof ts === "object" &&
    ts !== null &&
    "toDate" in ts &&
    typeof (ts as { toDate: () => Date }).toDate === "function"
  ) {
    return (ts as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

export function registerStaffRoutes(app: FastifyInstance, deps: Deps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // H-005 職員一覧（facility_admin 専用。所属メンバー＋保留中招待）
  typed.get("/v1/hospitals/:facilityId/staff", {
    config: { access: { tier: "authenticated" } },
    schema: {
      params,
      response: {
        200: z.object({
          members: z.array(
            z.object({
              membershipId: z.string(),
              userUid: z.string(),
              email: z.string().nullable(),
              role: staffRole,
              status: z.enum(["active", "revoked"]),
              createdAt: z.union([z.string(), z.null()]),
              revokedAt: z.union([z.string(), z.null()]),
            }),
          ),
          invitations: z.array(
            z.object({
              invitationId: z.string(),
              email: z.string(),
              role: staffRole,
              createdAt: z.union([z.string(), z.null()]),
            }),
          ),
        }),
        ...errors(401, 403),
      },
      tags: ["hospitals"],
      summary: "職員一覧（メンバー＋保留招待）",
      security: [{ bearerAuth: [] }],
    },
  }, async (req) => {
    await requireFacilityRole(deps, req, req.params.facilityId, ["facility_admin"]);
    const facilityId = req.params.facilityId;

    const memberRows = await queryDocs<{
      userUid: string;
      role: string;
      status: string;
      createdAt: unknown;
      revokedAt: unknown;
    }>(deps.db, "facilityMemberships", [
      { field: "facilityId", op: "==", value: facilityId },
    ], { limit: 200 });
    const invitationRows = await queryDocs<{
      email: string;
      role: string;
      status: string;
      createdAt: unknown;
    }>(deps.db, "facilityInvitations", [
      { field: "facilityId", op: "==", value: facilityId },
      { field: "status", op: "==", value: "pending" },
    ], { limit: 100 });

    // 保存済みデータに職員以外のロール・未知の状態が混ざっていても一覧を落とさない
    const staffMembers = memberRows.flatMap((r) => {
      const role = staffRole.safeParse(r.data.role);
      const status =
        r.data.status === "active" || r.data.status === "revoked"
          ? (r.data.status as "active" | "revoked")
          : null;
      if (!role.success || status === null) {
        req.log.warn({ membershipId: r.id }, "anomalous facilityMembership skipped in staff list");
        return [];
      }
      return [{ row: r, role: role.data, status }];
    });
    const invitations = invitationRows.flatMap((r) => {
      const role = staffRole.safeParse(r.data.role);
      if (!role.success) {
        req.log.warn({ invitationId: r.id }, "anomalous facilityInvitation skipped in staff list");
        return [];
      }
      return [{
        invitationId: r.id,
        email: r.data.email,
        role: role.data,
        createdAt: toIsoLocal(r.data.createdAt),
      }];
    });

    // メール表示は Firebase Auth が正本。未登録・退会済みは null（権限とは無関係の表示情報）
    // Auth への問い合わせは20件ずつに制限し、メンバー数分の同時呼び出しを避ける
    const members: Array<{
      membershipId: string;
      userUid: string;
      email: string | null;
      role: z.infer<typeof staffRole>;
      status: "active" | "revoked";
      createdAt: string | null;
      revokedAt: string | null;
    }> = [];
    for (let i = 0; i < staffMembers.length; i += 20) {
      const chunk = await Promise.all(
        staffMembers.slice(i, i + 20).map(async ({ row: r, role, status }) => {
          let email: string | null = null;
          try {
            const user = await deps.authAdmin.getUser(r.data.userUid);
            email = user?.email ?? null;
          } catch (err) {
            // user-not-found は正常（退会済み）。それ以外は Auth 障害の可能性があるため記録する
            if ((err as { code?: string }).code !== "auth/user-not-found") {
              req.log.warn({ err, userUidHash: auditUidHash(deps, r.data.userUid) }, "auth getUser failed in staff list");
            }
            email = null;
          }
          return {
            membershipId: r.id,
            userUid: r.data.userUid,
            email,
            role,
            status,
            createdAt: toIsoLocal(r.data.createdAt),
            revokedAt: toIsoLocal(r.data.revokedAt),
          };
        }),
      );
      members.push(...chunk);
    }

    return { members, invitations };
  });

  typed.post("/v1/hospitals/:facilityId/staff-invitations", {
    config: { access: { tier: "authenticated" } },
    schema: {
      params,
      body: invitationBody,
      response: { 201: z.object({ invitationId: z.string(), status: z.literal("pending") }), ...errors(400, 401, 403, 409) },
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
      response: { 200: z.object({ membershipId: z.string(), role: staffRole, status: z.enum(["active", "revoked"]) }), ...errors(400, 401, 403, 404, 409) },
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
      // 有効な施設管理者が権限を失う変更は、同時実行でも施設に管理者が残ることを tx 内で確認する
      const losesAdmin = member.role === "facility_admin" && member.status === "active" &&
        (role !== "facility_admin" || status !== "active");
      if (losesAdmin) {
        const adminsSnap = await tx.get(
          deps.db.collection("facilityMemberships")
            .where("facilityId", "==", req.params.facilityId)
            .where("role", "==", "facility_admin")
            .where("status", "==", "active")
            .limit(2),
        );
        const others = adminsSnap.docs.filter((d) => d.id !== req.params.membershipId);
        if (others.length === 0) {
          throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "施設に有効な管理者が残らなくなるため変更できません。");
        }
      }
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
