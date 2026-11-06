import type { Messaging } from "firebase-admin/messaging";
import type {
  PushFailureCode,
  PushGateway,
  PushSendResult,
} from "./deps.js";
import type { FastifyBaseLogger } from "fastify";

/**
 * Admin SDK の messaging.send 失敗を PushFailureCode へ写像する。
 *
 * `messaging/installation-id-not-registered` は FID ベース登録
 * （firebase-js-sdk#10135: httpsCallable が旧式トークンを裏で再登録し
 * FID 登録を潰す障害）でも返り得るため、registration-token-not-registered
 * と同様にトークン失効として扱い、端末docを無効化して以後の送信を止める。
 */
export function classifyMessagingError(err: unknown): PushFailureCode {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  switch (code) {
    case "messaging/registration-token-not-registered":
    case "messaging/installation-id-not-registered":
      return "unregistered";
    case "messaging/invalid-registration-token":
      return "invalid_token";
    // invalid-argument はメッセージレベルの汎用エラーでありトークン起因とは
    // 限らないため、誤ってデバイスを無効化しないよう unknown に倒す。
    case "messaging/server-unavailable":
    case "messaging/internal-error":
    case "messaging/unavailable":
    case "messaging/deadline-exceeded":
      return "unavailable";
    default:
      return "unknown";
  }
}

/** 本番用: Firebase Admin SDK の FCM v1 送信。 */
export class AdminPushGateway implements PushGateway {
  constructor(private readonly messaging: Messaging) {}

  async sendToDevice(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<PushSendResult> {
    try {
      const messageId = await this.messaging.send({
        token: params.token,
        notification: { title: params.title, body: params.body },
        ...(params.data ? { data: params.data } : {}),
      });
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, code: classifyMessagingError(err) };
    }
  }
}

/**
 * エミュレータ/未設定環境用: FCMはエミュレートされないため送信せず、
 * disabled を返す。トークンは有効のまま保持し、意図的スキップのため
 * NOTIFICATION_FAILED 監査も記録しない（呼び出し側で除外）。
 */
export class DisabledPushGateway implements PushGateway {
  constructor(private readonly logger: FastifyBaseLogger) {}

  async sendToDevice(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<PushSendResult> {
    this.logger.debug(
      { tokenLen: params.token.length },
      "push disabled (emulator): skipped FCM send",
    );
    return { ok: false, code: "disabled" };
  }
}
