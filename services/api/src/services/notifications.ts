import type { Deps } from "../deps.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import {
  invalidatePushDevice,
  listActivePushDevices,
} from "../repos/pushDevices.js";

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

/**
 * 送信直前の防御的検査: タイトル/本文がカタログ登録値のいずれかと
 * 完全一致することを確認する。テンプレート改竄・呼び出し側の誤用で
 * カタログ外文字列が混入した場合に送信を止める（PHI非含有の最終防衛線）。
 */
export function assertCatalogPayload(payload: NotificationPayload): void {
  const allowed = Object.values(NOTIFICATION_TEMPLATES).some(
    (t) => t.title === payload.title && t.body === payload.body,
  );
  if (!allowed) {
    throw new Error("notification payload is not in the approved catalog");
  }
}

/**
 * 患者の有効デバイスへ通知を送る（ベストエフォート）。
 * FCM障害・個別トークン失効でも呼び出し元の業務処理を止めない。
 * unregistered/invalid_token を返されたデバイスは invalid に更新し、
 * 以後の送信対象から外す（firebase-js-sdk#10135 による
 * installation-id-not-registered 静黙失効への対処を含む、ADR-0015）。
 */
export async function notifyPatient(
  deps: Deps,
  params: {
    patientUid: string;
    template: NotificationTemplate;
    /** 画面遷移用の不透明ドキュメントID（内容・症状ではない）。 */
    refId?: string;
    requestId?: string;
  },
): Promise<void> {
  const devices = await listActivePushDevices(deps.db, params.patientUid);
  if (devices.length === 0) return;

  const payload = buildNotificationPayload(params.template, params.refId);
  try {
    assertCatalogPayload(payload);
  } catch (err) {
    // カタログ外文言は送信しない。業務処理は継続し、障害として記録する。
    deps.logger.error(
      { err, template: params.template },
      "notification payload rejected by catalog guard",
    );
    return;
  }

  for (const device of devices) {
    try {
      const result = await deps.pushGateway.sendToDevice({
        token: device.data.token,
        title: payload.title,
        body: payload.body,
        data: payload.data,
      });
      if (result.ok) {
        await audit(deps, {
          actorType: "service",
          actorUidHash: auditUidHash(deps, params.patientUid),
          action: AUDIT_ACTIONS.NOTIFICATION_SENT,
          resourceType: "pushDevices",
          resourceIdHash: auditResourceHash(deps, device.id),
          outcome: "success",
          details: { template: params.template },
          ...(params.requestId ? { requestId: params.requestId } : {}),
        });
        continue;
      }

      if (result.code === "disabled") {
        // エミュレータ等で送信自体が無効。失敗でも成功でもないため
        // 監査・無効化は行わない。ゲートウェイはプロセスで一様なので
        // 残りのデバイスへの試行もスキップする。
        return;
      }
      if (result.code === "unregistered" || result.code === "invalid_token") {
        // 送信試行時点の lastSeenAt を渡し、その間の再登録を無効化で
        // 上書きしない（楽観的チェック、repos/pushDevices.ts 参照）。
        await invalidatePushDevice(
          deps.db,
          device.id,
          result.code,
          device.data.lastSeenAt,
        );
      }
      await audit(deps, {
        actorType: "service",
        actorUidHash: auditUidHash(deps, params.patientUid),
        action: AUDIT_ACTIONS.NOTIFICATION_FAILED,
        resourceType: "pushDevices",
        resourceIdHash: auditResourceHash(deps, device.id),
        outcome: "failed",
        details: { template: params.template, errorCode: result.code },
        ...(params.requestId ? { requestId: params.requestId } : {}),
      });
    } catch (err) {
      // 個別デバイスへの送信/無効化/監査失敗は残りのデバイス処理を止めない
      deps.logger.warn(
        { err, deviceId: device.id, template: params.template },
        "notification send attempt failed",
      );
    }
  }
}
