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
   * ブラウザから到達できるループバック（localhost/127.0.0.1）のみ許可する。
   */
  FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: z.string().optional(),
  FIREBASE_DATABASE_EMULATOR_HOST: z.string().optional(),
  DATABASE_EMULATOR_HOST: z.string().optional(), // legacy name
  DATABASE_URL: z.string().optional(),

  SERVER_HMAC_SECRET: z.string().default("change-me-local-dev"),
  APP_CHECK_MODE: z.enum(["enforce", "permissive"]).optional(),
  INTERNAL_JOB_TOKEN: z.string().optional(),
  API_DOCS_ENABLED: z.enum(["true", "false"]).optional(),
  API_CORS_ORIGINS: z.string().optional(),
  SYNTHETIC_SELF_SERVICE_ENABLED: z.enum(["true", "false"]).default("false"),
  SYNTHETIC_SELF_SERVICE_MAX_FACILITIES: z.coerce.number().int().min(1).max(10_000).default(1000),

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

  /** 下書き問診の保存日数（FR-I06 短期）。 */
  INTAKE_DRAFT_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /** Google Places (New) APIキー（Secret Managerから注入）。未設定時は施設検索が503。 */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /** Places Nearby Search の最大件数上限（1〜20）。 */
  PLACES_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(10),

  /**
   * 問診AIの本番承認フラグ（ADR-009）。未承認の既定falseでは
   * 固定質問のみ発行する（FR-I10 代替動作が安全側既定）。
   */
  AI_INTAKE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  /** 採用モデル（安価・高効率を既定。変更は審査済み版で管理）。 */
  VERTEX_AI_MODEL: z.string().default("gemini-2.5-flash-lite"),
  /** リージョン（PHIは国内処理）。 */
  VERTEX_AI_LOCATION: z.string().default("asia-northeast1"),
  /** LLM呼出しのタイムアウトms。 */
  VERTEX_AI_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /** /healthz の Firestore プローブ最長待機ms（ADR-0013）。LB超過を防ぐ上限付き。 */
  HEALTHZ_PROBE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(30_000)
    .default(2_000),
  /** プローブ結果のキャッシュms。0不可（無効化は課金read直結を招くため）。 */
  HEALTHZ_PROBE_CACHE_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(5_000),
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
  corsOrigins: readonly string[];
  syntheticSelfServiceEnabled: boolean;
  syntheticSelfServiceMaxFacilities: number;
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
  intakeDraftTtlDays: number;
  aiIntakeEnabled: boolean;
  vertexAiModel: string;
  vertexAiLocation: string;
  vertexAiTimeoutMs: number;
  healthzProbeTimeoutMs: number;
  healthzProbeCacheMs: number;
  googlePlacesApiKey: string | undefined;
  placesMaxResults: number;
}>;

const DUMMY_SECRETS = new Set(["", "change-me-local-dev"]);

function parseCorsOrigins(value: string, requireHttps: boolean): readonly string[] {
  if (value === "") return Object.freeze([]);
  const origins = value.split(",").map((origin) => origin.trim());
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("API_CORS_ORIGINS must contain exact HTTP(S) origins");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin ||
        (requireHttps && url.protocol !== "https:")) {
      throw new Error("API_CORS_ORIGINS must contain exact HTTP(S) origins");
    }
  }
  return Object.freeze(origins);
}

/** Admin SDK 側の内部エミュレータ接続先。Compose の `firebase` も許可する。 */
const INTERNAL_HOST_PORT = /^(localhost|127\.0\.0\.1|firebase):([1-9]\d{0,4})$/;
/** 署名URLを扱う公開ホスト。ブラウザから到達できるループバックのみ許可する。 */
const PUBLIC_HOST_PORT = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;

function isValidHostPort(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  return match !== null && Number(match[2]) <= 65535;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  const projectId =
    parsed.FIREBASE_PROJECT_ID ?? parsed.GCLOUD_PROJECT ?? "demo-mmr-dev";
  if (parsed.FIREBASE_PROJECT_ID && parsed.GCLOUD_PROJECT &&
      parsed.FIREBASE_PROJECT_ID !== parsed.GCLOUD_PROJECT) {
    throw new Error("FIREBASE_PROJECT_ID and GCLOUD_PROJECT must match");
  }
  // Admin SDKs select their endpoints independently; a partial setup could
  // otherwise disable production safeguards while still reaching cloud services.
  const emulatorHosts = [
    parsed.FIRESTORE_EMULATOR_HOST,
    parsed.FIREBASE_AUTH_EMULATOR_HOST,
    parsed.FIREBASE_STORAGE_EMULATOR_HOST,
    parsed.FIREBASE_DATABASE_EMULATOR_HOST,
  ];
  if (parsed.DATABASE_EMULATOR_HOST !== undefined) {
    throw new Error("Use FIREBASE_DATABASE_EMULATOR_HOST instead of DATABASE_EMULATOR_HOST");
  }
  if (emulatorHosts.some((host) => host !== undefined && host.trim() === "")) {
    throw new Error("Firebase emulator hosts must not be empty");
  }
  const emulator = emulatorHosts.some((host) => host !== undefined);
  if (emulator && emulatorHosts.some((host) => host === undefined)) {
    throw new Error("Auth, Firestore, Storage and RTDB emulator hosts must all be set");
  }
  if (emulator && emulatorHosts.some((host) => !isValidHostPort(host!, INTERNAL_HOST_PORT))) {
    throw new Error("Firebase emulator hosts must use local or Compose addresses and valid ports");
  }
  if (!emulator && parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST !== undefined) {
    throw new Error("Storage emulator public host requires all emulator hosts");
  }
  if (parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST !== undefined &&
      !parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST.trim()) {
    throw new Error("Storage emulator public host must not be empty");
  }
  if (parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST !== undefined &&
      !isValidHostPort(parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST, PUBLIC_HOST_PORT)) {
    throw new Error(
      "Storage emulator public host must be a localhost or 127.0.0.1 address with a valid port",
    );
  }
  if (emulator && parsed.FIREBASE_STORAGE_EMULATOR_HOST?.startsWith("firebase:") &&
      parsed.FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST === undefined) {
    throw new Error("A loopback Storage emulator public host is required for Compose");
  }
  if (emulator && !projectId.startsWith("demo-")) {
    throw new Error("Firebase emulators require a demo- project ID");
  }
  if (parsed.NODE_ENV === "production" && emulator) {
    throw new Error("Firebase emulators must not be configured in production");
  }
  if (!emulator && projectId.startsWith("demo-")) {
    throw new Error("A non-demo Firebase project ID is required without emulators");
  }
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
    corsOrigins: parseCorsOrigins(
      parsed.API_CORS_ORIGINS ??
        (parsed.NODE_ENV === "development" ? "http://localhost:5050,http://127.0.0.1:5050" : ""),
      parsed.NODE_ENV === "production",
    ),
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
    intakeDraftTtlDays: parsed.INTAKE_DRAFT_TTL_DAYS,
    aiIntakeEnabled: parsed.AI_INTAKE_ENABLED,
    syntheticSelfServiceEnabled: parsed.SYNTHETIC_SELF_SERVICE_ENABLED === "true",
    syntheticSelfServiceMaxFacilities: parsed.SYNTHETIC_SELF_SERVICE_MAX_FACILITIES,
    vertexAiModel: parsed.VERTEX_AI_MODEL,
    vertexAiLocation: parsed.VERTEX_AI_LOCATION,
    vertexAiTimeoutMs: parsed.VERTEX_AI_TIMEOUT_MS,
    healthzProbeTimeoutMs: parsed.HEALTHZ_PROBE_TIMEOUT_MS,
    healthzProbeCacheMs: parsed.HEALTHZ_PROBE_CACHE_MS,
    googlePlacesApiKey: parsed.GOOGLE_PLACES_API_KEY,
    placesMaxResults: parsed.PLACES_MAX_RESULTS,
  });
}
