import type { Deps } from "../deps.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { audit, auditResourceHash, auditUidHash } from "../lib/audit.js";
import {
  invalidatePushDevice,
  listActivePushDevices,
} from "../repos/pushDevices.js";

import {
  assertCatalogPayload,
  buildNotificationPayload,
  type NotificationTemplate,
} from "../domain/notifications.js";

export {
  assertCatalogPayload,
  buildNotificationPayload,
  NOTIFICATION_TEMPLATES,
  type NotificationPayload,
  type NotificationTemplate,
} from "../domain/notifications.js";

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
