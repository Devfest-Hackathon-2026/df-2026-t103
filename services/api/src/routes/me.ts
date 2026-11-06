import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { requireFreshAuth } from "../auth/gates.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import {
  deviceRegisterBodySchema,
  emptyBodySchema,
  onboardingConsentsBodySchema,
  profilePatchSchema,
} from "../domain/schemas.js";
import { assertParsed } from "../lib/errors.js";
import { RateRules } from "../lib/rateLimit.js";
import { getMe } from "../services/me.js";
import { getMyProfile, patchMyProfile } from "../services/profile.js";
import { recordOnboardingConsents } from "../services/onboarding.js";
import {
  cancelDeletion,
  getDeletionStatus,
  requestDeletion,
} from "../services/deletion.js";
import {
  registerDevice,
  unregisterDevice,
} from "../services/devices.js";
import { latestGrantedByType, listConsents } from "../repos/accounts.js";
import { z } from "zod";
import {
  consentsResponseSchema,
  deletionStatusSchema,
  deviceRegisterResponseSchema,
  errors,
  meResponseSchema,
  onboardingResponseSchema,
  profileResponseSchema,
} from "./apiDocs.js";

/**
 * 患者向けアカウント・同意・退会 API（API-001〜008）。
 * uid は検証済みトークンから解決し、URLにユーザーIDを置かない（03 §4.1）。
 */
export function registerMeRoutes(app: FastifyInstance, deps: Deps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-001
  typed.get(
    "/v1/me",
    {
      config: {
        access: {
          tier: "authenticated",
          allowPendingDeletion: true,
          allowSuspended: true,
        },
      },
      schema: {
        response: { 200: meResponseSchema, ...errors(401, 403, 429, 500, 503) },
        tags: ["me"],
        summary: "アカウント状態・同意状態・完了度",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => getMe(deps, req),
  );

  // API-003
  typed.get(
    "/v1/me/profile",
    {
      config: { access: { tier: "consented" } },
      schema: {
        response: { 200: profileResponseSchema, ...errors(401, 403, 404, 412, 429) },
        tags: ["me"],
        summary: "プロフィール取得（現行同意必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => getMyProfile(deps, uidOf(req)),
  );

  // API-002
  typed.patch(
    "/v1/me/profile",
    {
      config: { access: { tier: "consented" } },
      schema: {
        body: profilePatchSchema,
        response: {
          200: profileResponseSchema,
          ...errors(400, 401, 403, 412, 429, 500, 503),
        },
        tags: ["me"],
        summary: "プロフィール更新（現行同意必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => patchMyProfile(deps, uidOf(req), req.body),
  );

  // API-004
  typed.post(
    "/v1/onboarding/consents",
    {
      config: {
        access: { tier: "authenticated", rateRule: RateRules.consents },
      },
      schema: {
        body: onboardingConsentsBodySchema,
        response: {
          200: onboardingResponseSchema,
          ...errors(400, 401, 403, 409, 412, 429, 500, 503),
        },
        tags: ["me"],
        summary: "同意記録（Idempotency-Key 必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const auth = req.requestContext.auth!;
      return recordOnboardingConsents(deps, {
        uid: auth.uid,
        providers: auth.providers,
        emailVerified: auth.emailVerified ?? false,
        body: req.body,
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
    },
  );

  // API-005
  typed.get(
    "/v1/consents",
    {
      config: { access: { tier: "authenticated" } },
      schema: {
        response: { 200: consentsResponseSchema, ...errors(401, 403, 429) },
        tags: ["me"],
        summary: "同意履歴と現行版マッピング",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const consents = await listConsents(deps.db, uidOf(req));
      return {
        consents: consents.map(({ id, data }) => ({
          consentId: id,
          consentType: data.consentType,
          documentVersion: data.documentVersion,
          decision: data.decision,
          method: data.method,
          registrationSource: data.registrationSource,
          occurredAt: toIso(data.occurredAt),
          revokedAt: toIso(data.revokedAt) ?? null,
        })),
        currentByType: Object.fromEntries(
          [...latestGrantedByType(consents)].map(([type, doc]) => [
            type,
            doc.documentVersion,
          ]),
        ),
      };
    },
  );

  // API-006
  typed.post(
    "/v1/me/deletion-request",
    {
      config: {
        access: {
          tier: "authenticated",
          allowPendingDeletion: true,
          rateRule: RateRules.deletionRequest,
        },
      },
      schema: {
        body: emptyBodySchema.nullish(),
        response: {
          202: deletionStatusSchema,
          ...errors(400, 401, 403, 409, 429),
        },
        tags: ["me"],
        summary: "退会申請（30日保留・再認証必須・Idempotency-Key 必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      assertParsed(emptyBodySchema.safeParse(req.body ?? {}));
      requireFreshAuth(deps, req);
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await requestDeletion(deps, {
        uid: uidOf(req),
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
      return reply.status(202).send(result);
    },
  );

  // API-007
  typed.post(
    "/v1/me/deletion-request/cancel",
    {
      config: {
        access: {
          tier: "authenticated",
          allowPendingDeletion: true,
          rateRule: RateRules.deletionRequest,
        },
      },
      schema: {
        body: emptyBodySchema.nullish(),
        response: {
          200: deletionStatusSchema,
          ...errors(400, 401, 403, 404, 409, 429),
        },
        tags: ["me"],
        summary: "退会申請の取消（再認証・Idempotency-Key 必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      assertParsed(emptyBodySchema.safeParse(req.body ?? {}));
      requireFreshAuth(deps, req);
      const idempotencyKey = requireIdempotencyKey(req);
      return cancelDeletion(deps, {
        uid: uidOf(req),
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
    },
  );

  // API-008
  typed.get(
    "/v1/me/deletion-request",
    {
      config: {
        access: { tier: "authenticated", allowPendingDeletion: true },
      },
      schema: {
        response: { 200: deletionStatusSchema, ...errors(401, 403, 429) },
        tags: ["me"],
        summary: "退会申請の状態照会",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => getDeletionStatus(deps, uidOf(req)),
  );

  // API-042
  typed.post(
    "/v1/me/devices",
    {
      config: {
        access: { tier: "active", rateRule: RateRules.deviceRegister },
      },
      schema: {
        body: deviceRegisterBodySchema,
        response: {
          201: deviceRegisterResponseSchema,
          ...errors(400, 401, 403, 409, 412, 429),
        },
        tags: ["me"],
        summary: "プッシュ通知デバイス登録（Idempotency-Key 必須）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await registerDevice(deps, {
        uid: uidOf(req),
        body: req.body,
        idempotencyKey,
        requestId: req.requestContext.requestId,
      });
      return reply.status(201).send(result);
    },
  );

  // API-043
  typed.delete(
    "/v1/me/devices/:deviceId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: z.object({
          deviceId: z.string().regex(/^pdv_[0-9a-f]{64}$/),
        }),
        response: {
          204: z.null(),
          ...errors(400, 401, 403, 404, 412, 429),
        },
        tags: ["me"],
        summary: "プッシュ通知デバイス解除",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await unregisterDevice(deps, {
        uid: uidOf(req),
        deviceId: req.params.deviceId,
        requestId: req.requestContext.requestId,
      });
      return reply.status(204).send(null);
    },
  );
}

function toIso(value: unknown): string | undefined {
  if (value && typeof value === "object" && "toDate" in value) {
    try {
      const d = (value as { toDate(): unknown }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime())
        ? d.toISOString()
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
