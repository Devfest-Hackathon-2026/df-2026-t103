/**
 * 通知文言のカタログ（FR-O01/O05, 02 §10, ADR-011/0015）。
 * タイトル・本文はここに登録した一般文言のみ使用し、
 * 症状・病名・薬剤名・個人情報・ユーザー入力を一切含めない。
 * 文言を追加する場合は非PHIの一般表現のみとし、レビューで確認する。
 */
export const NOTIFICATION_TEMPLATES = {
  /** OCRの読み取りが完了し抽出候補の確認が可能になった通知。 */
  OCR_EXTRACTION_READY: {
    title: "お知らせ",
    body: "画像の読み取りが完了しました。",
  },
  /** 問診票の確定が完了した通知。 */
  QUESTIONNAIRE_READY: {
    title: "お知らせ",
    body: "問診票が作成されました。",
  },
} as const;

export type NotificationTemplate = keyof typeof NOTIFICATION_TEMPLATES;

export interface NotificationPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * テンプレートから通知ペイロードを構築する。
 * data は画面遷移用の非PHIキー（type=テンプレート名、refId=不透明ドキュメントID）
 * のみ。呼び出し元が自由文を注入する経路を持たない。
 */
export function buildNotificationPayload(
  template: NotificationTemplate,
  refId?: string,
): NotificationPayload {
  const t = NOTIFICATION_TEMPLATES[template];
  return {
    title: t.title,
    body: t.body,
    data: {
      type: template,
      ...(refId !== undefined ? { refId } : {}),
    },
  };
}

/** 固定文言と対応するtype、許可したdataキーだけを送信する。 */
export function assertCatalogPayload(payload: NotificationPayload): void {
  const data = payload.data;
  const entry = Object.entries(NOTIFICATION_TEMPLATES).find(
    ([type, t]) => data?.type === type && t.title === payload.title && t.body === payload.body,
  );
  if (
    !entry || !data || typeof data !== "object" || Array.isArray(data) ||
    Object.keys(data).some((key) => key !== "type" && key !== "refId") ||
    (Object.hasOwn(data, "refId") &&
      (typeof data.refId !== "string" || data.refId.length === 0))
  ) {
    throw new Error("notification payload is not in the approved catalog");
  }
}
