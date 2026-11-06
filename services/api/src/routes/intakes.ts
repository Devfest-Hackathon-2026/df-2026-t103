import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { RateRules } from "../lib/rateLimit.js";
import { requireIdempotencyKey } from "../lib/idempotency.js";
import {
  intakeAnswerPatchSchema,
  intakeAnswerSchema,
  intakeCreateSchema,
  intakeFinalizeSchema,
  intakeNextQuestionSchema,
  intakeSummarySchema,
  intakeSymptomsSchema,
} from "../domain/schemas.js";
import {
  createIntake,
  getIntakeDetail,
  patchAnswer,
  saveAnswer,
  submitSymptoms,
} from "../services/intakes.js";
import {
  finalizeIntake,
  requestNextQuestion,
  summarizeIntake,
} from "../services/intakeFlow.js";
import {
  answerSaveResponseSchema,
  errors,
  finalizeResponseSchema,
  intakeCreateResponseSchema,
  intakeDetailResponseSchema,
  intakeStateResponseSchema,
  nextQuestionResponseSchema,
  summaryResponseSchema,
} from "./apiDocs.js";

const intakeIdParam = z.object({ intakeId: z.string().min(1).max(200) });
const answerIdParam = z.object({
  intakeId: z.string().min(1).max(200),
  answerId: z.string().min(1).max(200),
});

/**
 * 問診 API（API-009〜016, FR-I01〜I10）。
 * 全エンドポイントは患者所有の問診のみ。revision による排他制御を強制。
 */
export function registerIntakeRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-009 問診下書き作成（Idempotency-Key 必須）
  typed.post(
    "/v1/intakes",
    {
      config: { access: { tier: "active" } },
      schema: {
        body: intakeCreateSchema,
        response: {
          201: intakeCreateResponseSchema,
          ...errors(400, 401, 403, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "問診下書き作成（status=draft, revision=1）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const result = await createIntake(deps, {
        uid: uidOf(req),
        body: req.body,
        idempotencyKey: requireIdempotencyKey(req),
      });
      return reply.status(201).send(result);
    },
  );

  // API-010 問診状態取得（中断再開に必要な質問・回答スナップショットを含む）
  typed.get(
    "/v1/intakes/:intakeId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: intakeIdParam,
        response: {
          200: intakeDetailResponseSchema,
          ...errors(401, 403, 404, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "問診状態取得（中断再開用スナップショット付き）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      getIntakeDetail(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        requestId: req.requestContext.requestId,
      }),
  );

  // API-011 初期症状・身体部位保存（FR-I01/I02）
  typed.post(
    "/v1/intakes/:intakeId/symptoms",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: intakeIdParam,
        body: intakeSymptomsSchema,
        response: {
          200: intakeStateResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "初期症状・身体部位保存（draft→questioning）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      submitSymptoms(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        body: req.body,
      }),
  );

  // API-012 次質問生成（LLM+固定fallback、rate limit）
  typed.post(
    "/v1/intakes/:intakeId/next-question",
    {
      config: {
        access: { tier: "active", rateRule: RateRules.intakeNextQuestion },
      },
      schema: {
        params: intakeIdParam,
        body: intakeNextQuestionSchema,
        response: {
          200: nextQuestionResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "次質問生成（スナップショット永続化後に返却）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      requestNextQuestion(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        body: req.body,
      }),
  );

  // API-013 回答保存（questionRevision + intake revision 検査）
  typed.post(
    "/v1/intakes/:intakeId/answers",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: intakeIdParam,
        body: intakeAnswerSchema,
        response: {
          200: answerSaveResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "回答保存（患者原文をそのまま保持, FR-I05）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      saveAnswer(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        body: req.body,
      }),
  );

  // API-014 回答修正（後続の active 質問を invalidated）
  typed.patch(
    "/v1/intakes/:intakeId/answers/:answerId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: answerIdParam,
        body: intakeAnswerPatchSchema,
        response: {
          200: answerSaveResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "回答修正（分岐再評価のため後続質問を無効化）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      patchAnswer(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        answerId: req.params.answerId,
        body: req.body,
      }),
  );

  // API-015 レビュー用要約（questioning→review）
  typed.post(
    "/v1/intakes/:intakeId/summary",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: intakeIdParam,
        body: intakeSummarySchema,
        response: {
          200: summaryResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "レビュー用要約（未回答は未回答のまま表示, FR-I07）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      summarizeIntake(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        body: req.body,
      }),
  );

  // API-016 確定revision生成（VAL-007: 未レビューは412、Idempotency-Key必須）
  typed.post(
    "/v1/intakes/:intakeId/finalize",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: intakeIdParam,
        body: intakeFinalizeSchema,
        response: {
          200: finalizeResponseSchema,
          ...errors(400, 401, 403, 404, 409, 412, 429, 500, 503),
        },
        tags: ["intakes"],
        summary: "確定revision生成（immutable questionnaire snapshot）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      finalizeIntake(deps, {
        uid: uidOf(req),
        intakeId: req.params.intakeId,
        body: req.body,
        idempotencyKey: requireIdempotencyKey(req),
        requestId: req.requestContext.requestId,
      }),
  );
}
