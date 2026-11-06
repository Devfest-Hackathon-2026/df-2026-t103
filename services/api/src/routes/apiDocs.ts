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

export const medicationResponseSchema = z.object({
  medicationId: z.string(),
  displayName: z.string(),
  genericName: z.string().nullable(),
  strength: z.string().nullable(),
  instructionsText: z.string().nullable(),
  quantity: z.string().nullable(),
  prescribedAt: z.string().nullable(),
  currentStatus: z.string(),
  confirmationStatus: z.string(),
  sourceType: z.string(),
  uploadId: z.string().nullable(),
  ocrJobId: z.string().nullable(),
  attachToQuestionnaire: z.boolean(),
  userConfirmedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const medicationListResponseSchema = z.object({
  medications: z.array(medicationResponseSchema),
});

export const extractionResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  candidates: z.array(
    z.object({
      candidateId: z.string(),
      name: z.string().nullable(),
      strength: z.string().nullable(),
      dosage: z.string().nullable(),
      quantity: z.string().nullable(),
      prescribedAt: z.string().nullable(),
      confidence: z.number(),
      evidenceSpan: z
        .object({ start: z.number(), end: z.number() })
        .optional(),
    }),
  ),
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

const questionOptionSchema = z.object({
  code: z.string(),
  label: z.string(),
});

export const questionDocSchema = z.object({
  questionId: z.string(),
  stepIndex: z.number(),
  questionText: z.string(),
  topic: z.string(),
  options: z.array(questionOptionSchema),
  generatedBy: z.string(),
  modelVersion: z.string().nullable(),
  questionRevision: z.number(),
  status: z.string(),
  createdAt: z.string().nullable(),
});

export const answerDocSchema = z.object({
  answerId: z.string(),
  questionId: z.string(),
  questionRevision: z.number(),
  stepIndex: z.number(),
  selectedCodes: z.array(z.string()),
  freeText: z.string().nullable(),
  answerState: z.string(),
  answeredAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const intakeCreateResponseSchema = z.object({
  intakeId: z.string(),
  status: z.literal("draft"),
  revision: z.number(),
});

export const intakeDetailResponseSchema = z.object({
  intakeId: z.string(),
  status: z.string(),
  revision: z.number(),
  initialSymptomText: z.string().nullable(),
  bodyLocations: z.array(z.string()),
  currentQuestionId: z.string().nullable(),
  questionCount: z.number(),
  safetyFlags: z.array(z.string()),
  aiEnabledForThisIntake: z.boolean(),
  questions: z.array(questionDocSchema),
  answers: z.array(answerDocSchema),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  finalizedAt: z.string().nullable(),
});

export const intakeStateResponseSchema = z.object({
  intakeId: z.string(),
  status: z.string(),
  revision: z.number(),
});

export const nextQuestionResponseSchema = z.object({
  intakeId: z.string(),
  intakeRevision: z.number(),
  question: questionDocSchema
    .omit({ status: true, createdAt: true })
    .nullable(),
});

export const answerSaveResponseSchema = z.object({
  answerId: z.string(),
  intakeRevision: z.number(),
});

const summarySectionSchema = z.object({
  value: z.string().nullable(),
  source: z.string().nullable(),
  answerState: z.string(),
});

export const summaryResponseSchema = z.object({
  intakeId: z.string(),
  status: z.literal("review"),
  intakeRevision: z.number(),
  summary: z.object({
    chiefComplaint: z.object({
      value: z.string().nullable(),
      source: z.string(),
    }),
    sections: z.record(z.string(), summarySectionSchema),
    unansweredTopics: z.array(z.string()),
    bodyLocations: z.array(z.string()),
    medicationSnapshots: z.array(
      z.object({
        medicationId: z.string(),
        displayName: z.string(),
        confirmed: z.literal(true),
      }),
    ),
    medicalHistorySnapshot: z.array(
      z.object({ conditionText: z.string(), source: z.string() }),
    ),
  }),
});

export const finalizeResponseSchema = z.object({
  intakeId: z.string(),
  questionnaireId: z.string(),
  questionnaireRevision: z.number(),
  status: z.literal("finalized"),
});

export const questionnaireListItemSchema = z.object({
  questionnaireId: z.string(),
  intakeId: z.string(),
  status: z.string(),
  latestRevision: z.number(),
  finalizedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const questionnaireListResponseSchema = z.object({
  questionnaires: z.array(questionnaireListItemSchema),
});

export const questionnaireDetailResponseSchema = z.object({
  questionnaireId: z.string(),
  intakeId: z.string(),
  status: z.string(),
  latestRevision: z.number(),
  finalizedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  revisions: z.array(
    z.object({
      versionNumber: z.number(),
      createdAt: z.string().nullable(),
      rawAnswerSnapshotHash: z.string(),
    }),
  ),
  revision: z.object({
    versionNumber: z.number(),
    schemaVersion: z.string(),
    chiefComplaint: z.object({
      value: z.string().nullable(),
      source: z.string(),
    }),
    sections: z.record(
      z.string(),
      z.object({
        value: z.string().nullable(),
        source: z.string().nullable(),
        answerState: z.string(),
      }),
    ),
    bodyLocations: z.array(z.string()),
    medicalHistorySnapshot: z.array(
      z.object({ conditionText: z.string(), source: z.string() }),
    ),
    medicationSnapshots: z.array(
      z.object({
        medicationId: z.string(),
        displayName: z.string(),
        confirmed: z.literal(true),
      }),
    ),
    unansweredTopics: z.array(z.string()),
    rawAnswerSnapshotHash: z.string(),
    summaryReviewConfirmedAt: z.string().nullable(),
    createdAt: z.string().nullable(),
  }),
});

export const deliveryCreateResponseSchema = z.object({
  deliveryId: z.string(),
  status: z.literal("created"),
});

export const deliveryGetResponseSchema = z.object({
  deliveryId: z.string(),
  status: z.string(),
  facilityId: z.string(),
  questionnaireId: z.string(),
  questionnaireRevisionId: z.string(),
  createdAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
});

export const facilitySearchItemSchema = z.object({
  source: z.literal("places"),
  placeId: z.string(),
  displayName: z.string(),
  formattedAddress: z.string(),
  lat: z.number(),
  lng: z.number(),
  primaryType: z.string().nullable(),
  receivingEnabled: z.boolean(),
  verifiedFacilityId: z.string().nullable(),
});

export const facilitySearchResponseSchema = z.object({
  facilities: z.array(facilitySearchItemSchema),
});

export const facilityDetailResponseSchema = z.object({
  facilityId: z.string(),
  displayName: z.string(),
  formattedAddress: z.string(),
  verificationStatus: z.string(),
  receivingEnabled: z.boolean(),
});
