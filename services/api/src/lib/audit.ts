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

export function auditResourceHash(deps: Deps, resourceId: string): string {
  return hmacSha256Hex(deps.config.hmacSecret, `audit-res:${resourceId}`);
}

/**
 * 監査イベントを書き込む。失敗しても業務処理は止めずログのみ。
 * PHI・パスワード・トークン・問診本文を details に含めないこと。
 */
export async function audit(
  deps: Deps,
  event: Omit<AuditEventDoc, "occurredAt">,
): Promise<void> {
  try {
    await writeAuditEvent(deps.db, {
      ...event,
      occurredAt: Timestamp.fromDate(deps.clock.now()),
    });
  } catch (err) {
    deps.logger.error({ err, action: event.action }, "audit event write failed");
  }
}

export function auditInTransaction(
  tx: Transaction,
  deps: Deps,
  event: Omit<AuditEventDoc, "occurredAt">,
): void {
  const ref = deps.db.collection("auditEvents").doc();
  tx.create(ref, {
    ...event,
    occurredAt: Timestamp.fromDate(deps.clock.now()),
  } as DocumentData);
}
