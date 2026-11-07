import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { requireFacilityRole } from "../auth/gates.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
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
}
