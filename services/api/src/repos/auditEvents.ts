import type { AuditEventDoc } from "../domain/firestoreDocs.js";
import type { FirestoreLike } from "./helpers.js";

export function auditEventsCollection(db: FirestoreLike) {
  return db.collection("auditEvents");
}

export async function writeAuditEvent(
  db: FirestoreLike,
  event: AuditEventDoc,
): Promise<string> {
  const ref = auditEventsCollection(db).doc();
  await ref.set(event);
  return ref.id;
}
