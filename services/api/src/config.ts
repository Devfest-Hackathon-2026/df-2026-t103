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
  FIREBASE_DATABASE_EMULATOR_HOST: z.string().optional(),
  DATABASE_EMULATOR_HOST: z.string().optional(), // legacy name
  DATABASE_URL: z.string().optional(),

  SERVER_HMAC_SECRET: z.string().default("change-me-local-dev"),
  APP_CHECK_MODE: z.enum(["enforce", "permissive"]).optional(),
  INTERNAL_JOB_TOKEN: z.string().optional(),

  REAUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  DELETION_GRACE_PERIOD_DAYS: z.coerce.number().int().min(0).default(30),
  DELETION_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  DELETION_SCAN_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(100),
});

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  logLevel: string;
  projectId: string;
  storageBucket: string;
  databaseUrl: string | undefined;
  emulator: boolean;
  hmacSecret: string;
  appCheckMode: "enforce" | "permissive";
  internalJobToken: string | undefined;
  reauthWindowSeconds: number;
  deletionGracePeriodDays: number;
  deletionJobMaxAttempts: number;
  deletionScanBatchSize: number;
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
    databaseUrl: parsed.DATABASE_URL,
    emulator,
    hmacSecret: parsed.SERVER_HMAC_SECRET,
    appCheckMode,
    internalJobToken: parsed.INTERNAL_JOB_TOKEN,
    reauthWindowSeconds: parsed.REAUTH_WINDOW_SECONDS,
    deletionGracePeriodDays: parsed.DELETION_GRACE_PERIOD_DAYS,
    deletionJobMaxAttempts: parsed.DELETION_JOB_MAX_ATTEMPTS,
    deletionScanBatchSize: parsed.DELETION_SCAN_BATCH_SIZE,
  });
}
