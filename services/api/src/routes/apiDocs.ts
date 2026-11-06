import { z } from "zod";

/**
 * OpenAPI 応答スキーマ。ドキュメント用途のため loose object で定義し、
 * 実応答の追加フィールドを剥がさない（serializer の安全側）。
 */

export const apiErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      retryable: z.boolean(),
      fieldErrors: z
        .array(z.object({ field: z.string(), message: z.string() }))
        .optional(),
    }),
  })
  .describe("標準エラー形式");

/** ステータスコード→標準エラーの response マップを生成する。 */
export function errors(
  ...codes: number[]
): Record<number, typeof apiErrorSchema> {
  return Object.fromEntries(codes.map((c) => [c, apiErrorSchema]));
}

export const healthResponseSchema = z.object({
  status: z.string().describe("ok"),
  service: z.string().describe("mmr-api"),
  emulator: z.boolean(),
});

export const legalDocumentsResponseSchema = z.object({
  documents: z.record(z.string(), z.unknown()),
  requiredConsents: z.array(z.string()),
  updatedAt: z.string().nullable(),
});

export const registerResponseSchema = z.object({
  registrationStatus: z.literal("created"),
  nextAction: z.literal("sign_in"),
  onboardingState: z.literal("profile_pending"),
});

export const consentStateSchema = z.object({
  current: z.boolean(),
  missing: z.array(z.string()),
});

export const deletionStatusSchema = z.object({
  status: z.enum([
    "none",
    "pending_deletion",
    "processing",
    "completed",
    "cancelled",
  ]),
  requestedAt: z.string().optional(),
  scheduledForDeletionAt: z.string().optional(),
  cancelDeadline: z.string().optional(),
  canCancel: z.boolean(),
  jobStatus: z.string().optional(),
});

export const meResponseSchema = z.object({
  uid: z.string(),
  accountStatus: z.string().nullable(),
  onboardingState: z.string(),
  emailVerified: z.boolean(),
  requiredConsents: consentStateSchema,
  profileComplete: z.boolean(),
  deletionRequest: deletionStatusSchema,
});

export const profileResponseSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
  profileComplete: z.boolean(),
});

export const onboardingResponseSchema = z.object({
  onboardingState: z.enum(["profile_pending", "completed"]),
});

export const consentsResponseSchema = z.object({
  consents: z.array(z.record(z.string(), z.unknown())),
  currentByType: z.record(z.string(), z.string()),
});

export const uploadInitResponseSchema = z.object({
  uploadId: z.string(),
  status: z.literal("pending"),
  upload: z.object({
    method: z.enum(["PUT", "POST"]),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string().describe("ISO8601"),
  }),
});

export const uploadCompleteResponseSchema = z.object({
  uploadId: z.string(),
  status: z.string(),
});

export const uploadProcessingResponseSchema = z.object({
  uploadId: z.string(),
  status: z.string(),
  ocrJob: z
    .object({
      jobId: z.string(),
      status: z.string(),
      errorCode: z.string().nullable(),
      candidateCount: z.number(),
    })
    .nullable()
    .describe("OCRジョブ。未起動時は null"),
});

export const jobRunResultSchema = z.object({
  jobId: z.string(),
  outcome: z.enum([
    "succeeded",
    "failed_retryable",
    "failed_terminal",
    "not_due",
    "already_running",
    "already_terminal",
    "not_found",
  ]),
  failedStep: z.string().optional(),
  attemptCount: z.number().optional(),
});

export const ocrRunResultSchema = z.object({
  jobId: z.string(),
  outcome: z.enum([
    "succeeded",
    "failed_retryable",
    "failed_terminal",
    "already_running",
    "already_terminal",
    "not_found",
  ]),
  errorCode: z.string().optional(),
  attemptCount: z.number().optional(),
});

export const scanResultSchema = z.object({
  scanned: z.number(),
  executed: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
  results: z.array(jobRunResultSchema),
});
