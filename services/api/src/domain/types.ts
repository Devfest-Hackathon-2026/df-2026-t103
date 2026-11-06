/** 04_DB設計書 §5 のenumに対応するドメイン型。 */

export type AccountStatus =
  | "onboarding_pending"
  | "active"
  | "suspended"
  | "pending_deletion"
  | "deleted";

export type OnboardingState =
  | "not_started"
  | "legal_pending"
  | "profile_pending"
  | "completed";

export type ConsentType =
  | "terms_of_service"
  | "privacy_policy_ack"
  | "health_data_collection"
  | "hospital_disclosure"
  | "optional_analytics";

export type RegistrationSource =
  | "email_registration"
  | "google_onboarding"
  | "passkey_onboarding"
  | "reconsent";

export type MembershipRole =
  | "patient"
  | "facility_staff"
  | "facility_clinician"
  | "facility_admin"
  | "platform_security_admin";

export type DeletionJobStatus =
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type UploadStatus =
  | "pending"
  | "uploaded"
  | "rejected"
  | "expired"
  | "deleted";

export type UploadSourcePurpose = "prescription_photo" | "medication_notebook";

export type OcrJobStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * OCR失敗分類（02 §8, FR-O06）。engine_unavailable は再試行可能。
 * page_limit_exceeded / upload_invalid は前処理時の終端失敗。
 */
export type OcrFailureCode =
  | "not_prescription"
  | "image_unclear"
  | "indeterminate"
  | "engine_unavailable"
  | "page_limit_exceeded"
  | "upload_invalid";

export type DeletionStepStatus = "pending" | "running" | "succeeded" | "failed";

export type RegistrationOperationStatus =
  | "reserved"
  | "auth_created"
  | "consents_committed"
  | "enabled"
  | "failed"
  | "expired";

/** ID token検証結果のうち業務で使う部分（admin SDK DecodedIdToken と同形）。 */
export interface VerifiedToken {
  uid: string;
  authTimeSeconds: number;
  emailVerified: boolean | undefined;
  signInProvider: string | undefined;
  providers: string[];
}

/** 外部依存（検証・Firestore・Storage・時計）を束ねたDIコンテナ。 */
export interface AuthVerifier {
  /** 例外を投げず null を返す。checkRevoked=true で失効/無効化を検査する。 */
  verifyIdToken(token: string, checkRevoked: boolean): Promise<VerifiedToken | null>;
}

export interface AppCheckVerifier {
  /** token を検証し、有効なら true、無効なら false。 */
  verify(token: string): Promise<boolean>;
}
