/**
 * 監査イベント名の正本（06 §6・04 §5.12）。
 * 新しい監査イベントは必ずここに登録してから発行する。
 * 命名は SNAKE_UPPER で統一（過去の `intake.finalized` 混入を防ぐ）。
 *
 * 全イベント共通の禁則（06 §6 禁止列・04 §5.12）:
 * 問診本文・症状・薬剤名・氏名住所・パスワード・トークン・署名URL・
 * 処方箋画像URLを details・属性に含めない。
 * 識別子は actorUidHash / resourceIdHash の HMAC 済み値のみ。
 */
export const AUDIT_ACTIONS = {
  // ---- 認証 ----
  /** Bearer 提示したが検証失敗（UID不明のため actorUidHash なし）。 */
  AUTH_FAIL: "AUTH_FAIL",
  // ---- 登録 ----
  REGISTRATION_ATTEMPT: "REGISTRATION_ATTEMPT",
  /** Auth作成後の Firestore 失敗からの復旧（将来の repair 経路用）。 */
  REGISTRATION_REPAIRED: "REGISTRATION_REPAIRED",
  // ---- 同意 ----
  CONSENT_ACCEPTED: "CONSENT_ACCEPTED",
  // ---- 問診 ----
  INTAKE_FINALIZED: "INTAKE_FINALIZED",
  /** 患者本人による問診/問診票の閲覧（不正アクセス追跡）。 */
  INTAKE_READ: "INTAKE_READ",
  // ---- アップロード ----
  UPLOAD_INIT: "UPLOAD_INIT",
  UPLOAD_COMPLETED: "UPLOAD_COMPLETED",
  // ---- 薬剤 ----
  MEDICATION_CREATED: "MEDICATION_CREATED",
  MEDICATION_UPDATED: "MEDICATION_UPDATED",
  MEDICATION_DELETED: "MEDICATION_DELETED",
  // ---- OCR ----
  OCR_JOB_SUCCEEDED: "OCR_JOB_SUCCEEDED",
  OCR_JOB_FAILED: "OCR_JOB_FAILED",
  /** 抽出候補（薬剤名等を含む）の閲覧。 */
  OCR_EXTRACTION_READ: "OCR_EXTRACTION_READ",
  // ---- 配送・施設 ----
  SUBMISSION_ACCEPTED: "SUBMISSION_ACCEPTED",
  DELIVERY_CREATED: "DELIVERY_CREATED",
  DELIVERY_VIEWED: "DELIVERY_VIEWED",
  /** 施設側の受領確認（閲覧済み ≠ 診療予約、FR-H10）。 */
  DELIVERY_ACKNOWLEDGED: "DELIVERY_ACKNOWLEDGED",
  HOSPITAL_READ: "HOSPITAL_READ",
  /** 施設スタッフ招待の発行。 */
  STAFF_INVITED: "STAFF_INVITED",
  /** メンバーシップのロール/状態変更（権限変更監査）。 */
  STAFF_MEMBERSHIP_UPDATED: "STAFF_MEMBERSHIP_UPDATED",
  MEMBERSHIP_REVOKED: "MEMBERSHIP_REVOKED",
  // ---- 運営 ----
  /** 運営による施設本人確認の承認（FR-H04 検証証跡とセット）。 */
  FACILITY_VERIFIED: "FACILITY_VERIFIED",
  FACILITY_REJECTED: "FACILITY_REJECTED",
  FACILITY_REVIEWS_LISTED: "FACILITY_REVIEWS_LISTED",
  FACILITY_VERIFICATION_RECORDS_LISTED: "FACILITY_VERIFICATION_RECORDS_LISTED",
  /** 施設受付の停止（運営緊急停止または施設管理者の受付停止）。 */
  FACILITY_RECEIVING_DISABLED: "FACILITY_RECEIVING_DISABLED",
  /** 施設管理者による受付の再開（H-006）。 */
  FACILITY_RECEIVING_ENABLED: "FACILITY_RECEIVING_ENABLED",
  /** 運営による失敗ジョブ一覧の閲覧（PII非表示、FR-O04）。 */
  JOB_FAILURES_LISTED: "JOB_FAILURES_LISTED",
  /** 運営による非識別の監査サマリー閲覧。 */
  AUDIT_EVENTS_LISTED: "AUDIT_EVENTS_LISTED",
  // ---- 削除 ----
  ACCOUNT_DELETION_REQUESTED: "ACCOUNT_DELETION_REQUESTED",
  ACCOUNT_DELETION_CANCELLED: "ACCOUNT_DELETION_CANCELLED",
  /** 削除ジョブのステップ失敗（retryable/terminal は outcome で区別）。 */
  ACCOUNT_DELETION_FAILED: "ACCOUNT_DELETION_FAILED",
  ACCOUNT_PURGED: "ACCOUNT_PURGED",
  /** 予定時刻+24h超過の未完了ジョブ（SLO-07 アラート）。 */
  DELETION_JOB_OVERDUE: "DELETION_JOB_OVERDUE",
  // ---- 通知（FCM・PHI非含有）----
  /** プッシュ通知用デバイストークンの登録。 */
  PUSH_DEVICE_REGISTERED: "PUSH_DEVICE_REGISTERED",
  PUSH_DEVICE_UNREGISTERED: "PUSH_DEVICE_UNREGISTERED",
  /** 通知送信成功。details は template 名のみ（文言・個人情報を含めない）。 */
  NOTIFICATION_SENT: "NOTIFICATION_SENT",
  /** 通知送信失敗（トークン無効化・一時障害の記録）。 */
  NOTIFICATION_FAILED: "NOTIFICATION_FAILED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const SUMMARY_ACTORS = ["patient", "staff", "platform", "service", "unknown"] as const;
export const SUMMARY_OUTCOMES = ["success", "failure", "other"] as const;

export interface AuditSummary {
  eventId: string;
  action: AuditAction | "UNKNOWN";
  actorType: (typeof SUMMARY_ACTORS)[number];
  occurredAt: string | null;
  decision: "allow" | "deny" | null;
  outcome: (typeof SUMMARY_OUTCOMES)[number] | null;
}
