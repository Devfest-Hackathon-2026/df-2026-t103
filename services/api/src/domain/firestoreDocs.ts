import type {
  AccountStatus,
  AnswerState,
  ConsentType,
  DeletionJobStatus,
  DeletionStepStatus,
  IntakeStatus,
  MedicationConfirmationStatus,
  MedicationCurrentStatus,
  MedicationSourceType,
  OcrFailureCode,
  OcrJobStatus,
  OnboardingState,
  QuestionGeneratedBy,
  QuestionStatus,
  RegistrationOperationStatus,
  RegistrationSource,
  UploadSourcePurpose,
  UploadStatus,
} from "./types.js";
import type { OcrCandidate } from "./ocr.js";

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

/** 04_DB設計書 §5.7。Storage 上の原本オブジェクトへの参照。objectPath に PII を含めない。 */
export interface UploadDoc {
  patientUid: string;
  storageBucket: string;
  objectPath: string;
  /** complete 時にサーバが確定した generation。未確定は未設定。 */
  objectGeneration?: string;
  /** init 時に申告された MIME。complete 時に実オブジェクトと照合する。 */
  mimeType: string;
  /** init 時に申告されたバイト数。complete 時に照合する。 */
  bytes: number;
  /** init 時に申告されたクライアント側 SHA-256(hex)。サーバ検証値ではない。 */
  sha256: string;
  status: UploadStatus;
  sourcePurpose: UploadSourcePurpose;
  /** 内容チェックフックの結果（SignatureContentScanner はマジックバイト照合）。 */
  contentScanStatus?: "pending" | "passed" | "failed";
  rejectedReason?: string;
  /**
   * Storage オブジェクトの tombstone 化の進行。rejected/expired 化時に
   * "pending" を立て、sweep が成功するまで再試行する（失敗しても
   * 残置されないようにするためのリトライ状態）。
   */
  objectCleanup?: "pending" | "done";
  /** Storage 側メタデータから取得した MD5(base64)。証跡用。 */
  objectMd5HashBase64?: string;
  completedAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  /** 保管期間の明示（FR-M06）。期限を過ぎた pending/uploaded は利用・復旧不可。 */
  expiresAt: unknown;
}

/**
 * 04_DB設計書 §5.8 ocrJobs。OCR結果は候補のみ保持し、
 * 利用者確認まで confirmed/registered にはしない（VAL-013, FR-O04）。
 */
export interface OcrJobDoc {
  uploadId: string;
  patientUid: string;
  status: OcrJobStatus;
  /** 使用したエンジン実装名（dummy/vision等）。 */
  engine: string;
  attempt: number;
  errorCode: OcrFailureCode | null;
  /** 抽出候補。unconfirmed としてのみ存在する。 */
  candidates: OcrCandidate[];
  /** 証跡用 OCR生テキスト（上限で切り詰め）。 */
  extractedText?: string;
  extractedTextTruncated?: boolean;
  /** 実行claimの所有トークン。結果書き込みは所有者のみ許可。 */
  claimOwner?: string;
  /** claimのリース期限。期限切れなら放棄とみなし回収可能。 */
  claimExpiresAt?: unknown;
  /** キュー投入状態。pending は enqueue 未完了（再投入で回収）。 */
  dispatchState: "pending" | "enqueued";
  createdAt: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  updatedAt: unknown;
}

/**
 * 04_DB設計書 §5.6 medications。同名薬・異用量は単純重複排除しない。
 * OCR候補は本人確認後にのみ confirmed。服薬状況は現在/過去/不明を必須保持。
 */
export interface MedicationDoc {
  patientUid: string;
  /** 表示名。入力または候補名（OCRの確信ではない）。 */
  displayName: string;
  /** 正規化不能なら null。 */
  genericName?: string | null;
  /** 規格。数値・単位の曖昧性をそのまま保持。 */
  strength?: string | null;
  /** 用法・用量の記載転記（医療指示を新規生成しない）。 */
  instructionsText?: string | null;
  /** 数量・日数。 */
  quantity?: string | null;
  /** 処方日 YYYY-MM-DD（服薬開始日と混同しない）。 */
  prescribedAt?: string | null;
  currentStatus: MedicationCurrentStatus;
  confirmationStatus: MedicationConfirmationStatus;
  sourceType: MedicationSourceType;
  /** 元画像への内部参照。 */
  uploadId?: string;
  /** 抽出処理の証跡。 */
  ocrJobId?: string;
  /** FR-M07: 問診票へ選択的添付する薬剤だけ true。 */
  attachToQuestionnaire: boolean;
  /** 本人が確認済みにした時刻。 */
  userConfirmedAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

/** 04_DB設計書 §5.4 intakes。問診進行・楽観ロック revision を保持。 */
export interface IntakeDoc {
  patientUid: string;
  status: IntakeStatus;
  /** 初回症状入力（最大1000字暫定）。 */
  initialSymptomText?: string;
  /** 体の部位コード（FR-I02）。 */
  bodyLocations: string[];
  currentQuestionId?: string;
  /** 発行済み質問数（暫定12上限）。 */
  questionCount: number;
  /** 楽観ロック用リビジョン。回答・遷移でインクリメント。 */
  revision: number;
  questionGraphVersion: string;
  safetyRulesetVersion: string;
  aiPolicyVersion: string;
  /** 本番のAI承認設定に基づく。未承認なら固定質問のみ。 */
  aiEnabledForThisIntake: boolean;
  /** 安全ルールが検出した注意喚起フラグ（FR-I09）。 */
  safetyFlags: string[];
  /** 外部AI呼出しの識別子を分離した時刻。 */
  lastProcessedAt?: unknown;
  /** 下書きの短期保存期限（FR-I06）。 */
  expiresAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  finalizedAt?: unknown;
}

/** intakes/{id}/questions/{id}。AI発行質問も含めたスナップショット。 */
export interface QuestionDoc {
  stepIndex: number;
  questionText: string;
  /** 収集トピック（onset_timing 等）。重複検査に使う。 */
  topic: string;
  options: Array<{ code: string; label: string }>;
  generatedBy: QuestionGeneratedBy;
  /** AI使用時のモデル/プロンプト版。APIキー・患者内容は含めない。 */
  modelVersion?: string;
  /** 質問バージョン。再発行で+1。 */
  questionRevision: number;
  status: QuestionStatus;
  createdAt: unknown;
}

/** intakes/{id}/answers/{questionId}（質問1件=回答1件、編集は上書き）。 */
export interface AnswerDoc {
  questionId: string;
  /** 表示時の質問版（stale回答の検出用）。 */
  questionRevision: number;
  stepIndex: number;
  /** 設問に存在するコードのみ。 */
  selectedCodes: string[];
  /** 患者の原文。空文字は未回答と混同しない（null保持）。 */
  freeText?: string | null;
  answerState: AnswerState;
  /** 初期は patient のみ。 */
  answerSource: "patient";
  answeredAt: unknown;
  updatedAt: unknown;
}

/** 04 §5.5 questionnaires。確定票メタ。 */
export interface QuestionnaireDoc {
  patientUid: string;
  intakeId: string;
  status: "finalized";
  latestRevision: number;
  reviewedAt: unknown;
  finalizedAt: unknown;
  createdAt: unknown;
}

/** 各トピックの回答要約（値の解釈を加えず原文/選択ラベルを保持）。 */
export interface SummarySection {
  /** 選択ラベル＋患者原文をつないだ表示値。未回答は null。 */
  value: string | null;
  /** 出所（answer:{questionId} / patient / patient_profile）。 */
  source: string | null;
  answerState: "answered" | "unknown" | "skipped" | "not_asked";
}

/** questionnaires/{id}/revisions/{rev} は immutable（04 §5.5）。 */
export interface QuestionnaireRevisionDoc {
  versionNumber: number;
  patientUid: string;
  schemaVersion: "1";
  chiefComplaint: { value: string | null; source: string };
  /** 出題済みトピックの要約（FR-I07: onset/frequency/severity/life_impact/…）。 */
  sections: Record<string, SummarySection>;
  bodyLocations: string[];
  medicalHistorySnapshot: Array<{
    conditionText: string;
    source: string;
  }>;
  /** BR-05: confirmed=true の本人確認済み薬のみ（FR-M07 attach済み）。 */
  medicationSnapshots: Array<{
    medicationId: string;
    displayName: string;
    confirmed: true;
  }>;
  /** 未回答・分からない・スキップ・未出題のトピック（「なし」としない）。 */
  unansweredTopics: string[];
  /** 配送版との一致検証用ハッシュ（sha256）。 */
  rawAnswerSnapshotHash: string;
  summaryReviewConfirmedAt: unknown;
  createdAt: unknown;
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
