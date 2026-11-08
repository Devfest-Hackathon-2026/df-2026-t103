import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { healthResponseSchema } from "./apiDocs.js";

/**
 * Firestore 接続の最小読み取りプローブ。
 * ドキュメントの有無ではなく read が成立するかだけを見る。
 * 失敗の詳細は公開応答に含めず、サーバログのみに残す（ADR-0013）。
 */
async function probeFirestore(
  deps: Deps,
  log: FastifyBaseLogger,
): Promise<"ok" | "error"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      deps.db.doc("appConfigs/publicLegalVersion").get(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("firestore probe timeout")),
          deps.config.healthzProbeTimeoutMs,
        );
        timer.unref();
      }),
    ]);
    return "ok";
  } catch (err) {
    log.warn({ err, check: "firestore" }, "health probe failed");
    return "error";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * API-040 / LB・コンテナヘルスチェック用。
 * tier "none": 認証・App Check・レート制限なしを明示宣言（LBが到達するため）。
 * 依存（Firestore）の疎通も返し、失敗時は 503 で LB から外せるようにする。
 * プローブは短期キャッシュ＋進行中共有し、要求集中が課金対象の読取に
 * 直結しないようにする。
 */
export function registerHealthRoutes(app: FastifyInstance, deps: Deps): void {
  let cached:
    | { result: "ok" | "error"; checkedAt: string; expiresAtMs: number }
    | undefined;
  let inflight: Promise<"ok" | "error"> | undefined;

  // Cloud Run reserves some paths ending in z; retain the local legacy URL.
  for (const path of ["/health", "/healthz"]) {
    app.withTypeProvider<ZodTypeProvider>().get(
      path,
      {
        config: { access: { tier: "none" } },
        schema: {
          // degraded も標準エラーではなくヘルス応答として返す
          response: { 200: healthResponseSchema, 503: healthResponseSchema },
          tags: ["ops"],
          summary: "ヘルスチェック（依存状態付き）",
        },
      },
      async (req, reply) => {
        void reply.header("cache-control", "no-store");
        const nowMs = deps.clock.now().getTime();
        if (!cached || cached.expiresAtMs <= nowMs) {
          // 同時到着は進行中プローブを共有し、単一インスタンス内で読取を1回に束ねる
          inflight ??= probeFirestore(deps, req.log).finally(() => {
            inflight = undefined;
          });
          const result = await inflight;
          const doneAt = deps.clock.now();
          cached = {
            result,
            checkedAt: doneAt.toISOString(),
            expiresAtMs: doneAt.getTime() + deps.config.healthzProbeCacheMs,
          };
        }
        const healthy = cached.result === "ok";
        return reply.status(healthy ? 200 : 503).send({
          status: healthy ? "ok" : "degraded",
          service: "mmr-api",
          emulator: deps.config.emulator,
          checks: { firestore: cached.result },
          checkedAt: cached.checkedAt,
        });
      },
    );
  }
}
