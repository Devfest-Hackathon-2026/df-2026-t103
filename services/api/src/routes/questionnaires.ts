import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import {
  getQuestionnaireDetail,
  listMyQuestionnaires,
} from "../services/questionnaires.js";
import {
  errors,
  questionnaireDetailResponseSchema,
  questionnaireListResponseSchema,
} from "./apiDocs.js";

const questionnaireIdParam = z.object({
  questionnaireId: z.string().min(1).max(200),
});
const revisionQuery = z.object({
  revision: z.coerce.number().int().min(1).optional(),
});

/**
 * 問診票 API（API-017/018）。確定後の不変スナップショットを読み取る。
 * revisions は immutable（作成後の変更APIは提供しない）。
 */
export function registerQuestionnaireRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const uidOf = (req: { requestContext: { auth?: { uid: string } } }) =>
    req.requestContext.auth!.uid;

  // API-017 本人の過去票一覧
  typed.get(
    "/v1/questionnaires",
    {
      config: { access: { tier: "active" } },
      schema: {
        response: {
          200: questionnaireListResponseSchema,
          ...errors(401, 403),
        },
        tags: ["questionnaires"],
        summary: "本人の過去問診票一覧",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => listMyQuestionnaires(deps, { uid: uidOf(req) }),
  );

  // API-018 問診票取得（既定: 最新版、?revision=N で過去版）
  typed.get(
    "/v1/questionnaires/:questionnaireId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: questionnaireIdParam,
        querystring: revisionQuery,
        response: {
          200: questionnaireDetailResponseSchema,
          ...errors(401, 403, 404),
        },
        tags: ["questionnaires"],
        summary: "問診票取得（不変revision・履歴ハッシュ付き）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      getQuestionnaireDetail(deps, {
        uid: uidOf(req),
        questionnaireId: req.params.questionnaireId,
        ...(req.query.revision !== undefined
          ? { revision: req.query.revision }
          : {}),
        requestId: req.requestContext.requestId,
      }),
  );
}
