import { Timestamp } from "firebase-admin/firestore";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { requireFacilityRole, requireFreshAuth } from "../auth/gates.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import {
  audit,
  auditInTransaction,
  auditResourceHash,
  auditUidHash,
  logAuditEvent,
} from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import type { AuditEventDoc, FacilityDoc } from "../domain/firestoreDocs.js";
import {
  acknowledgeDelivery,
  getDeliveryRecord,
  listDeliveriesByFacility,
} from "../repos/deliveries.js";
import { errors } from "./apiDocs.js";

const facilityParams = z.object({
  facilityId: z.string().min(1).max(200),
});
const deliveryParams = z.object({
  facilityId: z.string().min(1).max(200),
  deliveryId: z.string().min(1).max(200),
});

const HOSPITAL_ROLES = [
  "facility_staff",
  "facility_clinician",
  "facility_admin",
] as const;

const timestampOrNull = z
  .union([z.string(), z.null()])
  .describe("ISO8601 UTC or null");

const deliveryListItemSchema = z.object({
  deliveryId: z.string(),
  facilityId: z.string(),
  questionnaireId: z.string(),
  questionnaireRevisionId: z.string(),
  status: z.enum(["created", "delivered", "acknowledged", "failed", "revoked"]),
  patientDisplayName: z.string().nullable(),
  createdAt: timestampOrNull,
  deliveredAt: timestampOrNull,
  acknowledgedAt: timestampOrNull,
});

const deliveryListResponseSchema = z.object({
  deliveries: z.array(deliveryListItemSchema),
  nextCursor: z.string().nullable(),
});

const deliveryDetailResponseSchema = z.object({
  deliveryId: z.string(),
  facilityId: z.string(),
  questionnaireId: z.string(),
  questionnaireRevisionId: z.string(),
  status: z.enum(["created", "delivered", "acknowledged", "failed", "revoked"]),
  shareScope: z.record(z.string(), z.unknown()),
  patientIdentitySnapshot: z.record(z.string(), z.unknown()),
  questionnaireSnapshot: z.record(z.string(), z.unknown()),
  snapshotSha256: z.string(),
  createdAt: timestampOrNull,
  deliveredAt: timestampOrNull,
  acknowledgedAt: timestampOrNull,
});

const acknowledgeResponseSchema = z.object({
  deliveryId: z.string(),
  status: z.literal("acknowledged"),
  acknowledgedAt: z.string().nullable(),
});

function toIso(ts: unknown): string | null {
  if (!ts) return null;
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

/**
 * 病院受信API（API-031〜033）。
 * テナント境界: facilityId はURL確認のみ、権限は facilityMemberships 正本で照合（IDOR対策 NFR-05）。
 * 詳細閲覧は毎回 DELIVERY_VIEWED 監査記録（03_機能仕様書 §3.8）。
 */
export function registerHospitalRoutes(app: FastifyInstance, deps: Deps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-031 受信一覧（自院スコープ・20件カーソルページング）
  typed.get(
    "/v1/hospitals/:facilityId/deliveries",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: facilityParams,
        querystring: z.object({
          // deliveryId は dlv_<base36><base64url> 形式のみ許可し doc パスを安全にする
          cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
          status: z
            .enum(["created", "delivered", "acknowledged", "failed", "revoked"])
            .optional(),
          // 患者表示名の前方一致。自院スコープ内でのみ有効（検索制限 FR-H09）
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: {
          200: deliveryListResponseSchema,
          ...errors(401, 403),
        },
        tags: ["hospitals"],
        summary: "受信一覧（自院スコープ・検索制限、FR-H09）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requireFacilityRole(deps, req, req.params.facilityId, [
        ...HOSPITAL_ROLES,
      ]);
      const result = await listDeliveriesByFacility(
        deps.db,
        req.params.facilityId,
        {
          ...(req.query.cursor !== undefined && { cursor: req.query.cursor }),
          ...(req.query.limit !== undefined && { limit: req.query.limit }),
          ...(req.query.status !== undefined && { status: req.query.status }),
          ...(req.query.q !== undefined && { q: req.query.q }),
        },
      );
      return {
        deliveries: result.items.map((item) => ({
          deliveryId: item.id,
          facilityId: item.facilityId,
          questionnaireId: item.questionnaireId,
          questionnaireRevisionId: item.questionnaireRevisionId,
          status: item.status,
          patientDisplayName: item.patientDisplayName,
          createdAt: toIso(item.createdAt),
          deliveredAt: toIso(item.deliveredAt),
          acknowledgedAt: toIso(item.acknowledgedAt),
        })),
        nextCursor: result.nextCursor,
      };
    },
  );

  // API-032 受信詳細（閲覧ごとに DELIVERY_VIEWED 監査記録）
  typed.get(
    "/v1/hospitals/:facilityId/deliveries/:deliveryId",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: deliveryParams,
        response: {
          200: deliveryDetailResponseSchema,
          ...errors(401, 403, 404),
        },
        tags: ["hospitals"],
        summary: "受信詳細（閲覧監査付き、FR-H09）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { facilityId, deliveryId } = req.params;
      await requireFacilityRole(deps, req, facilityId, [...HOSPITAL_ROLES]);

      const delivery = await getDeliveryRecord(deps.db, deliveryId);
      if (!delivery || delivery.data.facilityId !== facilityId) {
        // 存在の有無も区別しない（E2E-004）
        await audit(deps, {
          actorType: "staff",
          actorUidHash: auditUidHash(deps, uidOf(req)),
          action: AUDIT_ACTIONS.DELIVERY_VIEWED,
          resourceType: "delivery",
          resourceIdHash: auditResourceHash(deps, deliveryId),
          facilityId,
          decision: "deny",
          requestId: req.id,
        });
        throw ApiError.notFound();
      }

      await audit(deps, {
        actorType: "staff",
        actorUidHash: auditUidHash(deps, uidOf(req)),
        action: AUDIT_ACTIONS.DELIVERY_VIEWED,
        resourceType: "delivery",
        resourceIdHash: auditResourceHash(deps, deliveryId),
        facilityId,
        decision: "allow",
        requestId: req.id,
      });

      const d = delivery.data;
      return {
        deliveryId,
        facilityId: d.facilityId,
        questionnaireId: d.questionnaireId,
        questionnaireRevisionId: d.questionnaireRevisionId,
        status: d.status,
        shareScope: d.shareScope,
        patientIdentitySnapshot: d.patientIdentitySnapshot,
        questionnaireSnapshot: d.questionnaireSnapshot,
        snapshotSha256: d.snapshotSha256,
        createdAt: toIso(d.createdAt),
        deliveredAt: toIso(d.deliveredAt),
        acknowledgedAt: toIso(d.acknowledgedAt),
      };
    },
  );

  // API-033 受領確認（閲覧済み ≠ 診療予約、FR-H10）
  typed.post(
    "/v1/hospitals/:facilityId/deliveries/:deliveryId/acknowledge",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: deliveryParams,
        response: {
          200: acknowledgeResponseSchema,
          ...errors(401, 403, 404, 409),
        },
        tags: ["hospitals"],
        summary: "受領確認（閲覧済み ≠ 診療予約、FR-H10）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { facilityId, deliveryId } = req.params;
      await requireFacilityRole(deps, req, facilityId, [...HOSPITAL_ROLES]);

      const delivery = await getDeliveryRecord(deps.db, deliveryId);
      if (!delivery || delivery.data.facilityId !== facilityId) {
        // 存在の有無も区別しない（E2E-004）
        await audit(deps, {
          actorType: "staff",
          actorUidHash: auditUidHash(deps, uidOf(req)),
          action: AUDIT_ACTIONS.DELIVERY_ACKNOWLEDGED,
          resourceType: "delivery",
          resourceIdHash: auditResourceHash(deps, deliveryId),
          facilityId,
          decision: "deny",
          requestId: req.id,
        });
        throw ApiError.notFound();
      }

      const now = deps.clock.now();
      const { found, alreadyAcknowledged, terminal, acknowledgedAt } =
        await acknowledgeDelivery(deps.db, deliveryId, uidOf(req), now);
      // 直前チェック後にドキュメントが消えた場合は監査せず404（遷移なし＝監査なし）
      if (!found) {
        throw ApiError.notFound();
      }
      // failed/revoked の終端状態への受領確認は状態機械違反
      if (terminal) {
        throw ApiError.conflict(
          ErrorCodes.REVISION_CONFLICT,
          "この配送物は受領確認できない状態です。",
        );
      }

      // 冪等な再受領では状態遷移が起きていないため監査は発行しない
      if (!alreadyAcknowledged) {
        await audit(deps, {
          actorType: "staff",
          actorUidHash: auditUidHash(deps, uidOf(req)),
          action: AUDIT_ACTIONS.DELIVERY_ACKNOWLEDGED,
          resourceType: "delivery",
          resourceIdHash: auditResourceHash(deps, deliveryId),
          facilityId,
          decision: "allow",
          requestId: req.id,
        });
      }

      return {
        deliveryId,
        status: "acknowledged" as const,
        acknowledgedAt: toIso(acknowledgedAt),
      };
    },
  );

  // H-006 施設設定の参照（facility_admin 専用）。
  // 正式名・所在地は運営審査済みの正本で自己変更不可（17.14）のため
  // 閲覧＋再審査案内のみ。受付可否の編集は PATCH で行う。
  typed.get(
    "/v1/hospitals/:facilityId/settings",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: facilityParams,
        response: {
          200: z.object({
            facilityId: z.string(),
            legalName: z.string(),
            displayName: z.string(),
            formattedAddress: z.string(),
            verificationStatus: z.enum(["pending", "verified", "rejected", "suspended"]),
            receivingEnabled: z.boolean(),
            receivingDisabledBy: z.enum(["platform", "staff"]).nullable(),
            receivingDisabledAt: timestampOrNull,
            receivingDisabledReason: z.string().nullable(),
          }),
          ...errors(401, 403, 404),
        },
        tags: ["hospitals"],
        summary: "施設設定の参照（H-006, facility_admin）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requireFacilityRole(deps, req, req.params.facilityId, ["facility_admin"]);
      const snap = await deps.db.doc(`facilities/${req.params.facilityId}`).get();
      const fac = snap.data() as FacilityDoc | undefined;
      if (!fac) throw ApiError.notFound();
      return {
        facilityId: req.params.facilityId,
        legalName: fac.legalName,
        displayName: fac.displayName,
        // 宛先確認情報は患者側APIと同じ formatted 文字列で返す
        formattedAddress:
          fac.address && typeof fac.address.formatted === "string"
            ? fac.address.formatted
            : "",
        verificationStatus: fac.verificationStatus,
        receivingEnabled: fac.receivingEnabled,
        receivingDisabledBy: fac.receivingDisabledBy ?? null,
        receivingDisabledAt: toIso(fac.receivingDisabledAt),
        // 停止理由は運営記録（非公開）。施設自身が記入した停止のみ開示する
        receivingDisabledReason:
          fac.receivingDisabledBy === "staff"
            ? (fac.receivingDisabledReason ?? null)
            : null,
      };
    },
  );

  // H-006 施設受付の停止/再開（facility_admin + 直近認証）。
  // 停止は新規配送の受付を止める運用キルスイッチ（既受領分は隠さない）。
  // 運営（platform）による停止は施設側では再開できない（API-037 の緊急停止を
  // 施設が解除できては意味をなさない）。遷移がない PATCH は監査を発行しない。
  typed.patch(
    "/v1/hospitals/:facilityId/settings",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        params: facilityParams,
        body: z
          .object({
            receivingEnabled: z.boolean(),
            reason: z.string().trim().min(1).max(500).optional(),
          })
          // 施設自身による受付停止は理由を必須とする（患者側の問い合わせ対応のため）
          .refine((b) => b.receivingEnabled || b.reason !== undefined),
        response: {
          200: z.object({ facilityId: z.string(), receivingEnabled: z.boolean() }),
          ...errors(400, 401, 403, 404, 409),
        },
        tags: ["hospitals"],
        summary: "施設受付の停止/再開（H-006, facility_admin）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      await requireFacilityRole(deps, req, req.params.facilityId, ["facility_admin"]);
      requireFreshAuth(deps, req);
      const actorUid = req.requestContext.auth!.uid;
      const enabling = req.body.receivingEnabled;
      const committedAudits: AuditEventDoc[] = [];
      await deps.db.runTransaction(async (tx) => {
        committedAudits.length = 0;
        const ref = deps.db.doc(`facilities/${req.params.facilityId}`);
        const snap = await tx.get(ref);
        const fac = snap.data() as FacilityDoc | undefined;
        if (!fac) throw ApiError.notFound();
        if (fac.receivingEnabled === enabling) return; // 遷移なし
        // 運営停止は施設側で再開できない（未設定は運営停止とみなす）
        if (enabling && fac.receivingDisabledBy !== "staff") {
          throw ApiError.conflict(
            ErrorCodes.REVISION_CONFLICT,
            "運営による受付停止のため、施設側では再開できません。運営へお問い合わせください。",
          );
        }
        const now = Timestamp.fromDate(deps.clock.now());
        tx.update(
          ref,
          enabling
            ? {
                receivingEnabled: true,
                receivingDisabledAt: null,
                receivingDisabledReason: null,
                receivingDisabledBy: null,
                updatedAt: now,
              }
            : {
                receivingEnabled: false,
                receivingDisabledAt: now,
                receivingDisabledReason: req.body.reason!,
                receivingDisabledBy: "staff",
                updatedAt: now,
              },
        );
        committedAudits.push(
          auditInTransaction(tx, deps, {
            actorType: "staff",
            actorUidHash: auditUidHash(deps, actorUid),
            action: enabling
              ? AUDIT_ACTIONS.FACILITY_RECEIVING_ENABLED
              : AUDIT_ACTIONS.FACILITY_RECEIVING_DISABLED,
            resourceType: "facility",
            resourceIdHash: auditResourceHash(deps, req.params.facilityId),
            facilityId: req.params.facilityId,
            requestId: req.id,
            decision: "allow",
            outcome: "success",
            // 停止理由は監査にも残す（再開で施設docから消えても追跡可能にするため）
            details: enabling
              ? { from: "disabled" }
              : { from: "enabled", reason: req.body.reason! },
          }),
        );
      });
      for (const e of committedAudits) logAuditEvent(deps, e);
      return { facilityId: req.params.facilityId, receivingEnabled: enabling };
    },
  );
}
