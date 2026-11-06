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
import { registerIntakeRoutes } from "./routes/intakes.js";
import { registerQuestionnaireRoutes } from "./routes/questionnaires.js";
import { registerInternalJobRoutes } from "./routes/internalJobs.js";
import { registerCors } from "./lib/cors.js";
import { registerDeliveryRoutes } from "./routes/deliveries.js";
import { registerFacilityRoutes } from "./routes/facilities.js";
import { registerHospitalRoutes } from "./routes/hospitals.js";
import { registerStaffRoutes } from "./routes/staff.js";

/**
 * Fastify アプリケーションの組み立て。
 * 認証・App Check・状態/同意・認可・レート制御は enforceAccess に集約し、
 * ルート側は config.access で利用階層を宣言する。
 */
export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger.child({ component: "http" }),
    // Cloud Run/GFE が唯一のイングレスという前提で、直近1ホップだけ信頼し
    // レート制限のキーを実クライアントIPにする。前提: GFE以外から
    // 到達不可（直接接続可能な経路があると XFF 最終エントリを偽装して
    // IP単位レート制限を回避できる）。ホップ数のみの信頼は Fastify v5 が
    // fail-closed 化したため関数形式で同等の 1 ホップ信頼を明示する。
    trustProxy: (_addr: string, hop: number) => hop === 0,
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

  registerCors(app, deps.config.corsOrigins);

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
    registerIntakeRoutes(instance, deps);
    registerQuestionnaireRoutes(instance, deps);
    registerInternalJobRoutes(instance, deps);
    registerDeliveryRoutes(instance, deps);
    registerFacilityRoutes(instance, deps);
    registerHospitalRoutes(instance, deps);
    registerStaffRoutes(instance, deps);
  });

  return app;
}
