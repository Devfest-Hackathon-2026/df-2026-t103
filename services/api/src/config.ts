import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  GCLOUD_PROJECT: z.string().min(1).optional(),
  FIREBASE_STORAGE_BUCKET: z.string().min(1).optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  FIREBASE_STORAGE_EMULATOR_HOST: z.string().optional(),
  /**
   * クライアントが署名URLでアクセスする側の Storage Emulator ホスト。
   * Docker Compose では FIREBASE_STORAGE_EMULATOR_HOST は内部DNS名
   * （firebase:9199）でブラウザから解決不能なため、公開側を別途設定する。
   */
  FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: z.string().optional(),
  FIREBASE_DATABASE_EMULATOR_HOST: z.string().optional(),
  DATABASE_EMULATOR_HOST: z.string().optional(), // legacy name
  DATABASE_URL: z.string().optional(),

  SERVER_HMAC_SECRET: z.string().default("change-me-local-dev"),
  APP_CHECK_MODE: z.enum(["enforce", "permissive"]).optional(),
  INTERNAL_JOB_TOKEN: z.string().optional(),
  API_DOCS_ENABLED: z.enum(["true", "false"]).optional(),

  REAUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  DELETION_GRACE_PERIOD_DAYS: z.coerce.number().int().min(0).default(30),
  DELETION_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  DELETION_SCAN_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(100),

  UPLOAD_MAX_ACTIVE: z.coerce.number().int().positive().default(20),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  UPLOAD_DOC_TTL_DAYS: z.coerce.number().int().positive().default(30),

  OCR_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** OCR実行claimのリース(ms)。期限切れの running は放棄とみなし回収する。 */
  OCR_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  OCR_TASKS_LOCATION: z.string().default("asia-northeast1"),
  OCR_TASKS_QUEUE: z.string().optional(),
  /** OCRタスクが叩くAPIの外部URL（Cloud Run URL）。未設定時はキュー無効。 */
  OCR_TASKS_TARGET_URL: z.string().optional(),
  /** タスクOIDC発行用サービスアカウント。 */
  OCR_TASKS_OIDC_SA: z.string().optional(),
});

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  logLevel: string;
  projectId: string;
  storageBucket: string;
  /** クライアント向けの Storage Emulator 公開ホスト（署名URL生成用）。 */
  storageEmulatorPublicHost: string | undefined;
  databaseUrl: string | undefined;
  emulator: boolean;
  hmacSecret: string;
  appCheckMode: "enforce" | "permissive";
  internalJobToken: string | undefined;
  apiDocsEnabled: boolean;
  reauthWindowSeconds: number;
  deletionGracePeriodDays: number;
  deletionJobMaxAttempts: number;
  deletionScanBatchSize: number;
  /** 有効（pending/uploaded かつ期限内）アップロードの患者当たり上限（FR-M01 枚数制限）。 */
  uploadMaxActive: number;
  /** 署名URLの有効秒数（短命URL）。 */
  uploadUrlTtlSeconds: number;
  /** uploadsドキュメントの保管日数（FR-M06）。 */
  uploadDocTtlDays: number;
  ocrMaxAttempts: number;
  /** OCR実行claimのリース(ms)。 */
  ocrLeaseMs: number;
  ocrTasksLocation: string;
  ocrTasksQueue: string | undefined;
  ocrTasksTargetUrl: string | undefined;
  ocrTasksOidcSa: string | undefined;
}>;

const DUMMY_SECRETS = new Set(["", "change-me-local-dev"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  const projectId =
    parsed.FIREBASE_PROJECT_ID ?? parsed.GCLOUD_PROJECT ?? "demo-mmr-dev";
  const emulator = Boolean(
    parsed.FIRESTORE_EMULATOR_HOST || parsed.FIREBASE_AUTH_EMULATOR_HOST,
  );
  const appCheckMode =
    parsed.APP_CHECK_MODE ?? (emulator ? "permissive" : "enforce");

  if (
    parsed.NODE_ENV === "production" &&
    !emulator &&
    DUMMY_SECRETS.has(parsed.SERVER_HMAC_SECRET)
  ) {
    throw new Error(
      "SERVER_HMAC_SECRET must be set to a real secret in production",
    );
  }

  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    projectId,
    storageBucket:
      parsed.FIREBASE_STORAGE_BUCKET ?? `${projectId}.appspot.com`,
    storageEmulatorPublicHost: parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST,
    databaseUrl: parsed.DATABASE_URL,
    emulator,
    hmacSecret: parsed.SERVER_HMAC_SECRET,
    appCheckMode,
    internalJobToken: parsed.INTERNAL_JOB_TOKEN,
    apiDocsEnabled:
      parsed.API_DOCS_ENABLED !== undefined
        ? parsed.API_DOCS_ENABLED === "true"
        : emulator || parsed.NODE_ENV !== "production",
    reauthWindowSeconds: parsed.REAUTH_WINDOW_SECONDS,
    deletionGracePeriodDays: parsed.DELETION_GRACE_PERIOD_DAYS,
    deletionJobMaxAttempts: parsed.DELETION_JOB_MAX_ATTEMPTS,
    deletionScanBatchSize: parsed.DELETION_SCAN_BATCH_SIZE,
    uploadMaxActive: parsed.UPLOAD_MAX_ACTIVE,
    uploadUrlTtlSeconds: parsed.UPLOAD_URL_TTL_SECONDS,
    uploadDocTtlDays: parsed.UPLOAD_DOC_TTL_DAYS,
    ocrMaxAttempts: parsed.OCR_MAX_ATTEMPTS,
    ocrLeaseMs: parsed.OCR_LEASE_MS,
    ocrTasksLocation: parsed.OCR_TASKS_LOCATION,
    ocrTasksQueue: parsed.OCR_TASKS_QUEUE,
    ocrTasksTargetUrl: parsed.OCR_TASKS_TARGET_URL,
    ocrTasksOidcSa: parsed.OCR_TASKS_OIDC_SA,
  });
}
