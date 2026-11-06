import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { ApiError } from "../lib/errors.js";
import { getLegalDocuments } from "../repos/legalConfig.js";
import { errors, legalDocumentsResponseSchema } from "./apiDocs.js";

/** API-039: 公開法務文書の現行版・ハッシュ。クライアントが同意画面の版照合に使う。 */
export function registerPublicRoutes(app: FastifyInstance, deps: Deps): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/public/legal-documents",
    {
      config: { access: { tier: "public" } },
      schema: {
        response: { 200: legalDocumentsResponseSchema, ...errors(503) },
        tags: ["public"],
        summary: "公開法務文書（現行版・必須同意一覧）",
      },
    },
    async () => {
      const docs = await getLegalDocuments(deps.db);
      if (!docs) {
        throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "公開文書が準備できていません。");
      }
      return {
        documents: docs.documents,
        requiredConsents: docs.requiredConsents,
        updatedAt: docs.updatedAt ?? null,
      };
    },
  );
}
