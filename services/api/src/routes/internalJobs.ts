import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { ApiError, assertParsed } from "../lib/errors.js";
import { DeletionWorker } from "../workers/deletionJob.js";
import { sweepExpiredUploads } from "../services/uploads.js";
import { OcrWorker } from "../workers/ocrJob.js";
import {
  errors,
  jobRunResultSchema,
  ocrRunResultSchema,
  scanResultSchema,
} from "./apiDocs.js";

/**
 * 内部ジョブエンドポイント（Cloud Scheduler / Cloud Tasks 想定）。
 * 本番は Tasks OIDC 等に置き換える（infra issue #31）。ローカルは
 * X-Internal-Job-Token 共有鍵またはエミュレータ緩和で動作する。
 */
export function registerInternalJobRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const worker = new DeletionWorker(deps);
  const ocrWorker = new OcrWorker(deps);

  // 期限スキャン（Scheduler → 本エンドポイント）
  typed.post(
    "/v1/internal/jobs/deletion-scan",
    {
      config: { access: { tier: "internal" } },
      schema: {
        response: { 200: scanResultSchema, ...errors(401, 403, 429, 500) },
        tags: ["internal"],
        summary: "期限到達 deletionJobs のスキャン・実行（Scheduler呼び出し）",
      },
    },
    async () => worker.scanDueJobs(),
  );

  // 保持期限切れアップロードのスイープ（Scheduler → 本エンドポイント）
  typed.post(
    "/v1/internal/jobs/upload-expiry-scan",
    {
      config: { access: { tier: "internal" } },
      schema: {
        response: {
          200: z.object({
            scanned: z.number(),
            expired: z.number(),
            cleaned: z.number(),
          }),
          ...errors(401, 403, 429, 500),
        },
        tags: ["internal"],
        summary: "期限切れ uploads の expired 化・実体除去（Scheduler呼び出し）",
      },
    },
    async () => sweepExpiredUploads(deps),
  );

  // 単一ジョブ実行（Tasks の invoke target 想定。冪等）
  typed.post(
    "/v1/internal/jobs/deletion-jobs/:jobId/run",
    {
      config: { access: { tier: "internal" } },
      schema: {
        params: z.object({ jobId: z.string().min(1).max(200) }),
        response: {
          200: jobRunResultSchema,
          ...errors(400, 401, 403, 404, 429, 500),
        },
        tags: ["internal"],
        summary: "単一削除ジョブの実行（Tasks invoke target。冪等）",
      },
    },
    async (req) => {
      const params = assertParsed(
        z.object({ jobId: z.string().min(1).max(200) }).safeParse(req.params),
      );
      const result = await worker.runJob(params.jobId);
      if (result.outcome === "not_found") {
        throw ApiError.notFound("削除ジョブが見つかりません。");
      }
      return result;
    },
  );

  // OCRジョブ実行（Cloud Tasks HTTP タスクの invoke target。冪等・retryable は 5xx で再送）
  typed.post(
    "/v1/internal/jobs/ocr/:jobId/run",
    {
      config: { access: { tier: "internal" } },
      schema: {
        params: z.object({ jobId: z.string().min(1).max(200) }),
        response: {
          200: ocrRunResultSchema,
          ...errors(400, 401, 403, 404, 429, 500),
        },
        tags: ["internal"],
        summary: "単一OCRジョブの実行（Tasks invoke target。冪等）",
      },
    },
    async (req) => {
      const params = assertParsed(
        z.object({ jobId: z.string().min(1).max(200) }).safeParse(req.params),
      );
      const result = await ocrWorker.runJob(params.jobId);
      if (result.outcome === "not_found") {
        throw ApiError.notFound("OCRジョブが見つかりません。");
      }
      // Cloud Tasks の再送に任せるため、再試行可能失敗は 5xx で返す
      if (result.outcome === "failed_retryable") {
        throw new ApiError(500, "INTERNAL", "OCRジョブを再試行します。", {
          retryable: true,
        });
      }
      return result;
    },
  );
}
