import type { AppConfig } from "./config.js";

/**
 * PHI/秘密を構造化ログに出さないための logger オプション。
 * - Authorization / App Check / Idempotency-Key ヘッダを redact
 * - リクエストボディはログしない（パスワード・自由記述を含み得るため）
 */
export function loggerOptions(config: AppConfig) {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-firebase-appcheck']",
        "req.headers['idempotency-key']",
        "req.headers['x-internal-job-token']",
        "req.headers.cookie",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req(request: { method: string; url: string; id?: unknown }) {
        return {
          method: request.method,
          url: request.url,
          requestId: request.id,
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}
