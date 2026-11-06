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
  | "upload_invalid"
  | "worker_interrupted";

/** FR-M05: 服薬状況を必ず明示（不明も状態として保存）。 */
export type MedicationCurrentStatus = "taking" | "past" | "not_sure";

/** VAL-013/FR-M04: 抽出候補は利用者確認まで confirmed にしない。 */
export type MedicationConfirmationStatus =
  | "unconfirmed"
  | "confirmed"
  | "rejected";

export type MedicationSourceType =
  | "manual"
  | "prescription_photo"
  | "medication_notebook";

/** 04 §5.4 問診進行状態。archived は期限切れ・中断終端。 */
export type IntakeStatus =
  | "draft"
  | "safety_check"
  | "questioning"
  | "review"
  | "finalized"
  | "archived";

/** 質問生成元。modelVersion に APIキー・患者内容を含めない。 */
export type QuestionGeneratedBy = "fixed_template" | "llm" | "fallback";

/** 回答編集で分岐が変わった後続質問は invalidated。 */
export type QuestionStatus = "active" | "invalidated" | "answered";

/** 空文字と未回答を区別する（unknown=分からない、skipped=回答しない）。 */
export type AnswerState = "answered" | "unknown" | "skipped";

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
