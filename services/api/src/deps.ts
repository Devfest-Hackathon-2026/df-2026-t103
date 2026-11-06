import type { AppConfig } from "./config.js";
import type { Clock } from "./lib/clock.js";
import type { FirestoreLike } from "./repos/helpers.js";
import type { FastifyBaseLogger } from "fastify";

/**
 * DI コンテナ。テストでは各フィールドをフェイクに差し替える。
 * 認証・App Check・レート制御・管理操作は後続の認証/ミドルウェア基盤で追加する。
 */
export interface Deps {
  config: AppConfig;
  db: FirestoreLike;
  clock: Clock;
  logger: FastifyBaseLogger;
}
