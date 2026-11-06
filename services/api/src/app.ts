import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Deps } from "./deps.js";
import { resolveRequestId } from "./lib/requestId.js";
import { ApiError, sendError } from "./lib/errors.js";
import { enforceAccess } from "./auth/gates.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerMedicationRoutes } from "./routes/medications.js";
import { registerInternalJobRoutes } from "./routes/internalJobs.js";

/**
 * Fastify アプリケーションの組み立て。
 * 認証・App Check・状態/同意・認可・レート制御は enforceAccess に集約し、
 * ルート側は config.access で利用階層を宣言する。
 */
export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger.child({ component: "http" }),
    // X-Request-Id を genReqId で解決し req.id と一体化する。
    // ログ（requestId=request.id）と応答ヘッダ・エラー本文が同一IDで相関できる。
    genReqId: (req) => {
      const raw = req.headers["x-request-id"];
      const header = Array.isArray(raw) ? raw[0] : raw;
      return resolveRequestId(header);
    },
  });

  // zod スキーマを Fastify バリデーションと OpenAPI 生成に接続
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // OpenAPI 仕様と Swagger UI（既定: 非 production または emulator）
  if (deps.config.apiDocsEnabled) {
    void app.register(fastifySwagger, {
      openapi: {
        info: {
          title: "もしもし問診 API",
          version: "0.1.0",
          description:
            "患者・病院向け問診 API。認証は Firebase ID token (Bearer)、副作用POSTは Idempotency-Key 必須。",
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "Firebase ID Token",
            },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    void app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  // requestContext へ Fastify の req.id をそのまま格納し応答ヘッダへ反映
  app.addHook("onRequest", async (req, reply) => {
    req.requestContext = { requestId: req.id };
    void reply.header("x-request-id", req.id);
  });

  // ルートごとのアクセス階層を一括適用（認証→App Check→状態・同意→認可→レート）。
  // preValidation で実行し、スキーマ検証より先に保護パイプラインを通す（02 §4）。
  app.addHook("preValidation", async (req) => enforceAccess(deps, req));

  app.setErrorHandler((err, req, reply) => sendError(req, reply, err));
  app.setNotFoundHandler((req, reply) => {
    void sendError(req, reply, ApiError.notFound());
  });

  // ルートはプラグイン内に包んで登録する。@fastify/swagger は onRoute フックで
  // ルートを収集するが、register() の実行は非同期なので、同期で app.get された
  // ルートは収集対象にならない。register チェーンで実行順を保証する。
  void app.register(async (instance) => {
    registerHealthRoutes(instance, deps);
    registerPublicRoutes(instance, deps);
    registerAuthRoutes(instance, deps);
    registerMeRoutes(instance, deps);
    registerUploadRoutes(instance, deps);
    registerMedicationRoutes(instance, deps);
    registerInternalJobRoutes(instance, deps);
  });

  return app;
}
