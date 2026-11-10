import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { makeTestDeps } from "../helpers/deps.js";
import { authHeader, buildTestApp } from "../helpers/app.js";
import { encodeOpaqueCursor } from "../../src/lib/opaqueCursor.js";

const url = "/v1/operator/audit-events";
async function setup() {
  const deps = makeTestDeps();
  const app = buildTestApp(deps);
  await app.ready();
  await deps.db.doc("facilityMemberships/operator").set({ userUid: "operator", facilityId: "platform", role: "platform_security_admin", status: "active" });
  return { app, deps };
}

describe("GET operator audit summaries", () => {
  it("rejects missing auth, ordinary staff, revoked operators, and missing App Check", async () => {
    const { app, deps } = await setup();
    try {
      const denied = await app.inject({ url });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["cache-control"]).toBe("private, no-store");
      await deps.db.doc("facilityMemberships/staff").set({ userUid: "staff", facilityId: "hospital", role: "facility_admin", status: "active" });
      expect((await app.inject({ url, headers: authHeader("staff") })).statusCode).toBe(403);
      await deps.db.doc("facilityMemberships/operator").update({ status: "revoked" });
      expect((await app.inject({ url, headers: authHeader("operator") })).statusCode).toBe(403);

    } finally { await app.close(); }
  });

  it("requires App Check in enforce mode", async () => {
    const deps = makeTestDeps({ appCheckMode: "enforce" });
    const app = buildTestApp(deps);
    try {
      await deps.db.doc("facilityMemberships/operator").set({ userUid: "operator", facilityId: "platform", role: "platform_security_admin", status: "active" });
      expect((await app.inject({ url, headers: authHeader("operator") })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { ...authHeader("operator"), "x-firebase-appcheck": "bad-appcheck" } })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { ...authHeader("operator"), "x-firebase-appcheck": "valid-appcheck" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("returns only safe fields, normalizes untrusted enum values, and audits the read", async () => {
    const { app, deps } = await setup();
    try {
      await deps.db.doc("auditEvents/PRIVATE-legacy-id").set({ action: "STAFF_MEMBERSHIP_UPDATED", actorType: "staff", occurredAt: Timestamp.now(), outcome: "PRIVATE-outcome", decision: "deny", details: { patient: "PRIVATE" }, facilityId: "PRIVATE", actorUidHash: "PRIVATE", resourceIdHash: "PRIVATE", requestId: "PRIVATE" });
      await deps.db.doc("auditEvents/unknown").set({ action: "PRIVATE", actorType: "PRIVATE", occurredAt: Timestamp.now(), decision: "PRIVATE" });
      const response = await app.inject({ url, headers: authHeader("operator") });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.body).not.toContain("PRIVATE");
      const body = response.json();
      expect(body.items).toHaveLength(2);
      for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["action", "actorType", "decision", "eventId", "occurredAt", "outcome"]);
      expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: "STAFF_MEMBERSHIP_UPDATED", actorType: "staff", decision: "deny", outcome: "other" }), expect.objectContaining({ action: "UNKNOWN", actorType: "unknown", decision: null, outcome: null })]));
      const events = await deps.db.collection("auditEvents").get();
      expect(events.docs.some((doc) => doc.data()["action"] === "AUDIT_EVENTS_LISTED")).toBe(true);
    } finally { await app.close(); }
  });

  it("paginates equal timestamps without disclosing paths or accepting foreign/tampered cursors", async () => {
    const { app, deps } = await setup();
    try {
      for (let i = 0; i < 3; i++) await deps.db.doc(`auditEvents/PRIVATE-${i}`).set({ action: "MEMBERSHIP_REVOKED", actorType: "staff", occurredAt: Timestamp.fromMillis(1000), outcome: "success" });
      const first = (await app.inject({ url: `${url}?limit=2`, headers: authHeader("operator") })).json();
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(first.nextCursor, "base64url").toString()).not.toContain("PRIVATE");
      const second = (await app.inject({ url: `${url}?limit=2&cursor=${first.nextCursor}`, headers: authHeader("operator") })).json();
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((item) => item.eventId)).size).toBe(3);
      const foreign = encodeOpaqueCursor(deps.config.hmacSecret, "accounts/PRIVATE");
      for (const cursor of [foreign, "tampered"]) {
        const result = await app.inject({ url: `${url}?cursor=${cursor}`, headers: authHeader("operator") });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ items: [], nextCursor: null });
      }
    } finally { await app.close(); }
  });

  it("bounds queries and refuses unsupported identifier filters", async () => {
    const { app } = await setup();
    try {
      for (const query of ["limit=0", "limit=101", "limit=1.5", "cursor=bad%2Fpath", "patientUid=PRIVATE"]) expect((await app.inject({ url: `${url}?${query}`, headers: authHeader("operator") })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
