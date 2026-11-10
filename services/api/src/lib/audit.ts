import {
  Timestamp,
  type Transaction,
  type DocumentData,
} from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { AuditEventDoc } from "../domain/firestoreDocs.js";
import { hmacSha256Hex } from "./hash.js";
import { writeAuditEvent } from "../repos/auditEvents.js";

/** uid を監査用の安定ハッシュへ変換（本文・直接識別子を監査に残さない）。 */
export function auditUidHash(deps: Deps, uid: string): string {
  return hmacSha256Hex(deps.config.hmacSecret, `audit-uid:${uid}`);
}

/** リソースIDを監査用の安定ハッシュへ変換。生IDを resourceIdHash に入れない。 */
export function auditResourceHash(deps: Deps, resourceId: string): string {
  return hmacSha256Hex(deps.config.hmacSecret, `audit-res:${resourceId}`);
}

function isoOf(ts: unknown): string | undefined {
  if (ts && typeof ts === "object" && typeof (ts as { toDate?: unknown }).toDate === "function") {
    try {
      return (ts as { toDate(): Date }).toDate().toISOString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 監査イベントを構造化ログとしても出力する。
 * `jsonPayload.auditEvent` フィールドで Cloud Logging シンクが
 * Security Audit Sink（別プロジェクト保管）へ転送できるようにする
 * （02図 WORK→AUDIT）。PHI は書き込む doc と同じく含まない。
 */
export function logAuditEvent(deps: Deps, event: AuditEventDoc): void {
  deps.logger.info(
    {
      auditEvent: {
        ...event,
        occurredAt: isoOf(event.occurredAt) ?? deps.clock.now().toISOString(),
      },
    },
    "audit event",
  );
}

/**
 * 監査イベントを書き込む。失敗しても業務処理は止めずログのみ。
 * 書き込み成功時はシンク転送用の構造化ログも出力する。
 * PHI・パスワード・トークン・問診本文を details に含めないこと。
 */
export async function audit(
  deps: Deps,
  event: Omit<AuditEventDoc, "occurredAt">,
): Promise<void> {
  const doc: AuditEventDoc = {
    ...event,
    occurredAt: Timestamp.fromDate(deps.clock.now()),
  };
  try {
    await writeAuditEvent(deps.db, doc);
  } catch (err) {
    deps.logger.error({ err, action: event.action }, "audit event write failed");
    return;
  }
  logAuditEvent(deps, doc);
}

/**
 * トランザクション内で監査イベントを予約する。
 * 構造化ログは呼出側がコミット確定後に `logAuditEvent` で出力すること
 * （ロールバック時に幻の監査レコードをシンクへ流さないため）。
 * 戻り値は書き込んだイベントそのもの。
 */
export function auditInTransaction(
  tx: Transaction,
  deps: Deps,
  event: Omit<AuditEventDoc, "occurredAt">,
): AuditEventDoc {
  const ref = deps.db.collection("auditEvents").doc();
  const doc: AuditEventDoc = {
    ...event,
    occurredAt: Timestamp.fromDate(deps.clock.now()),
  };
  tx.create(ref, doc as DocumentData);
  return doc;
}
