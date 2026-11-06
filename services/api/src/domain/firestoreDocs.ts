import type {
  AccountStatus,
  ConsentType,
  DeletionJobStatus,
  DeletionStepStatus,
  OnboardingState,
  RegistrationOperationStatus,
  RegistrationSource,
} from "./types.js";

/** Timestamp は Timestamp（fake側も同型）として扱う。 */
export interface AccountDoc {
  uid: string;
  accountStatus: AccountStatus;
  onboardingState: OnboardingState;
  emailVerified: boolean;
  providers: string[];
  lastAuthenticatedAt?: unknown;
  deletionRequestedAt?: unknown;
  deletionScheduledAt?: unknown;
  previousAccountStatus?: AccountStatus;
  deletionJobId?: string;
  /** 直近の取消済みジョブ参照。取消後の状態照会に使う。 */
  lastDeletionJobId?: string;
  /** 退会申請に伴うリフレッシュトークン失効の成功記録。 */
  deletionTokensRevokedAt?: unknown;
  schemaVersion: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface LegalConsentDoc {
  subjectUid: string;
  consentType: ConsentType;
  documentVersion: string;
  documentHash: string;
  decision: "granted" | "denied";
  method: "explicit_checkbox";
  registrationSource: RegistrationSource;
  scope?: Record<string, unknown>;
  occurredAt: unknown;
  revokedAt: unknown;
  schemaVersion: string;
}

export interface RegistrationOperationDoc {
  operationHash: string;
  requestHash: string;
  uid: string;
  status: RegistrationOperationStatus;
  legalVersionSet: Record<string, { version: string; documentHash: string }>;
  createdAt: unknown;
  updatedAt: unknown;
  expiresAt: unknown;
  lastErrorClass?: string;
}

export interface IdempotencyKeyDoc {
  keyHash: string;
  requestHash: string;
  status: "processing" | "completed";
  result?: Record<string, unknown>;
  createdAt: unknown;
  expiresAt: unknown;
}

export interface PatientProfileDoc {
  patientUid: string;
  familyName?: string;
  givenName?: string;
  familyNameKana?: string;
  givenNameKana?: string;
  birthDate?: string;
  phoneNumber?: string;
  postalCode?: string;
  address?: { prefecture: string; city: string; line1: string; line2?: string };
  medicalHistory?: Array<{
    conditionText: string;
    selfReported: boolean;
    updatedAt: unknown;
  }>;
  allergyStatus?: "unknown" | "no_known" | "reported";
  locale: string;
  profileComplete: boolean;
  accessibilityPreferences?: Record<string, unknown>;
  updatedAt: unknown;
}

export interface DeletionJobDoc {
  subjectUid: string;
  requestedAt: unknown;
  executeAfter: unknown;
  status: DeletionJobStatus;
  steps: Record<string, DeletionStepStatus>;
  stepResults?: Record<string, { deletedCount?: number; note?: string }>;
  attemptCount: number;
  lastErrorCode: string | null;
  lastStartedAt?: unknown;
  completedAt?: unknown;
  cancelledAt?: unknown;
  nextAttemptAt?: unknown;
  /** uploads ドキュメント削除前に退避した Storage オブジェクト参照（失敗分は残す）。 */
  pendingStorageObjects?: Array<{
    bucket: string;
    path: string;
    generation?: string;
  }>;
  overdueAlertedAt?: unknown;
}

export interface AuditEventDoc {
  actorType: "patient" | "staff" | "platform" | "service";
  actorUidHash?: string;
  action: string;
  resourceType?: string;
  resourceIdHash?: string;
  facilityId?: string;
  occurredAt: unknown;
  requestId?: string;
  decision?: "allow" | "deny";
  outcome?: string;
  details?: Record<string, string | number | boolean>;
  policyVersion?: string;
}
