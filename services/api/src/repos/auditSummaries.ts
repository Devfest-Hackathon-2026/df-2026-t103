import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import {
  AUDIT_ACTIONS,
  SUMMARY_ACTORS,
  type AuditSummary,
  type AuditAction,
} from "../domain/auditEvents.js";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../lib/opaqueCursor.js";
import { hmacSha256Hex } from "../lib/hash.js";
import { queryDocs } from "./helpers.js";

const actions = new Set<string>(Object.values(AUDIT_ACTIONS));

function normalizeOutcome(value: unknown): AuditSummary["outcome"] {
  if (value == null) return null;
  if (value === "success") return "success";
  if (typeof value === "string" && ["failure", "failed", "retryable", "terminal"].includes(value)) return "failure";
  return "other";
}

function summary(deps: Deps, id: string, data: Record<string, unknown>): AuditSummary {
  const timestamp = data["occurredAt"];
  let occurredAt: string | null = null;
  if (timestamp && typeof timestamp === "object" && "toDate" in timestamp && typeof timestamp.toDate === "function") {
    const date: unknown = timestamp.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) occurredAt = date.toISOString();
  }
  return {
    eventId: `ae_${hmacSha256Hex(deps.config.hmacSecret, `audit-summary:${id}`)}`,
    action: typeof data["action"] === "string" && actions.has(data["action"]) ? data["action"] as AuditAction : "UNKNOWN",
    actorType: SUMMARY_ACTORS.includes(data["actorType"] as AuditSummary["actorType"]) ? data["actorType"] as AuditSummary["actorType"] : "unknown",
    occurredAt,
    decision: data["decision"] === "allow" || data["decision"] === "deny" ? data["decision"] : null,
    outcome: normalizeOutcome(data["outcome"]),
  };
}

/** O-002: Return a bounded operational summary, never raw audit documents. */
export async function listAuditSummaries(deps: Deps, opts: { limit: number; cursor?: string }) {
  let startAfterDoc: DocumentSnapshot | undefined;
  if (opts.cursor) {
    const path = decodeOpaqueCursor(deps.config.hmacSecret, opts.cursor);
    if (!path || !/^auditEvents\/[^/]+$/.test(path)) return { items: [], nextCursor: null };
    const snap = await deps.db.doc(path).get();
    if (!snap.exists || snap.data()?.["occurredAt"] == null) return { items: [], nextCursor: null };
    startAfterDoc = snap;
  }
  const rows = await queryDocs<Record<string, unknown>>(deps.db, "auditEvents", [], {
    orderBy: [{ field: "occurredAt", direction: "desc" }],
    ...(startAfterDoc ? { startAfterDoc } : {}),
    limit: opts.limit + 1,
  });
  return {
    items: rows.slice(0, opts.limit).map((row) => summary(deps, row.id, row.data)),
    nextCursor: rows.length > opts.limit ? encodeOpaqueCursor(deps.config.hmacSecret, rows[opts.limit - 1]!.path) : null,
  };
}
