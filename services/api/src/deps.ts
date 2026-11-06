import type { AppConfig } from "./config.js";
import type { Clock } from "./lib/clock.js";
import type { RateLimiter } from "./lib/rateLimit.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
} from "./domain/types.js";
import type { FirestoreLike } from "./repos/helpers.js";
import type { FastifyBaseLogger } from "fastify";

/** Firebase Auth 管理操作（サービス層から見える最小IF）。 */
export interface AuthAdmin {
  createUser(props: {
    uid: string;
    email: string;
    password: string;
    emailVerified: boolean;
    disabled: boolean;
  }): Promise<{ uid: string }>;
  updateUser(
    uid: string,
    props: { disabled?: boolean; emailVerified?: boolean },
  ): Promise<unknown>;
  getUserByEmail(email: string): Promise<{ uid: string; disabled: boolean }>;
  deleteUser(uid: string): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

/** Cloud Storage のオブジェクト削除IF。 */
export interface StorageDeleter {
  /** 対象が存在しなくても成功として扱う。generation 指定時は一致を確認。 */
  deleteObject(
    bucket: string,
    objectPath: string,
    generation?: string,
  ): Promise<void>;
}

export interface Deps {
  config: AppConfig;
  db: FirestoreLike;
  auth: AuthVerifier;
  authAdmin: AuthAdmin;
  appCheck: AppCheckVerifier;
  storage: StorageDeleter;
  rateLimiter: RateLimiter;
  clock: Clock;
  logger: FastifyBaseLogger;
}
