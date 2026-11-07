import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { authHeader, buildTestApp } from "../helpers/app.js";
import { encodeOpaqueCursor } from "../../src/lib/opaqueCursor.js";

const base = "/v1/operator/facilities";
const checks = { existence: true, applicant: false, receiverContact: true, location: true };
const body = { checks, verificationRecordId: "PRIVATE-license", reason: "PRIVATE-reason" };
async function setup() {
  const deps = makeTestDeps();
  const app = buildTestApp(deps);
  await app.ready();
  await deps.db.doc("facilityMemberships/operator").set({ userUid: "operator", facilityId: "platform", role: "platform_security_admin", status: "active" });
  return { app, deps };
}
async function seed(deps: TestDeps, id: string, status = "pending") {
  await deps.db.doc(`facilities/${id}`).set({ legalName: "合成施設", displayName: "合成施設", verificationStatus: status, receivingEnabled: true, createdAt: Timestamp.fromMillis(1000), contactChannel: { email: "PRIVATE" }, receivingDisabledReason: "PRIVATE" });
}

describe("operator facility review", () => {
  it("requires operator membership for all endpoints and App Check in enforce mode", async () => {
    const { app, deps } = await setup();
    try {
      for (const request of [{ method: "GET", url: base }, { method: "GET", url: `${base}/fac/verification-records` }, { method: "POST", url: `${base}/fac/reject`, payload: body }]) {
        expect((await app.inject(request)).statusCode).toBe(401);
        expect((await app.inject({ ...request, headers: authHeader("staff") })).statusCode).toBe(403);
      }
      await deps.db.doc("facilityMemberships/operator").update({ status: "revoked" });
      expect((await app.inject({ url: base, headers: authHeader("operator") })).statusCode).toBe(403);
    } finally { await app.close(); }
    const enforced = buildTestApp(makeTestDeps({ appCheckMode: "enforce" }));
    try { expect((await enforced.inject({ url: base, headers: authHeader("operator") })).statusCode).toBe(401); }
    finally { await enforced.close(); }
  });

  it("paginates facilities with equal timestamps and excludes private fields", async () => {
    const { app, deps } = await setup();
    try {
      await seed(deps, "fac-a"); await seed(deps, "fac-b");
      const first = await app.inject({ url: `${base}?limit=1`, headers: authHeader("operator") });
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("private, no-store");
      expect(first.body).not.toContain("PRIVATE");
      const second = (await app.inject({ url: `${base}?limit=1&cursor=${first.json().nextCursor}`, headers: authHeader("operator") })).json();
      expect(second.items).toHaveLength(1);
      expect(second.items[0].facilityId).not.toBe(first.json().items[0].facilityId);
      expect(second.nextCursor).toBeNull();
      expect((await app.inject({ url: `${base}?cursor=tampered`, headers: authHeader("operator") })).json()).toEqual({ items: [], nextCursor: null });
      expect((await app.inject({ url: `${base}?limit=101`, headers: authHeader("operator") })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("returns only verification summaries and binds the cursor to the selected facility", async () => {
    const { app, deps } = await setup();
    try {
      await seed(deps, "fac-a"); await seed(deps, "fac-b");
      for (let i = 0; i < 2; i++) await deps.db.doc(`facilityVerificationRecords/PRIVATE-${i}`).set({ facilityId: "fac-a", checks: { ...checks, applicant: true }, verifierUid: "PRIVATE", verificationRecordId: "PRIVATE", note: "PRIVATE", createdAt: Timestamp.fromMillis(1000) });
      const response = await app.inject({ url: `${base}/fac-a/verification-records?limit=1`, headers: authHeader("operator") });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("PRIVATE");
      expect(response.json().items[0]).toEqual({ recordId: expect.stringMatching(/^vr_[0-9a-f]{64}$/), decision: "verified", checks: { ...checks, applicant: true }, createdAt: "1970-01-01T00:00:01.000Z" });
      const cursor = response.json().nextCursor;
      expect((await app.inject({ url: `${base}/fac-a/verification-records?limit=1&cursor=${cursor}`, headers: authHeader("operator") })).json().items).toHaveLength(1);
      expect((await app.inject({ url: `${base}/fac-b/verification-records?cursor=${cursor}`, headers: authHeader("operator") })).json()).toEqual({ items: [], nextCursor: null });
      const foreign = encodeOpaqueCursor(deps.config.hmacSecret, "accounts/PRIVATE");
      expect((await app.inject({ url: `${base}/fac-a/verification-records?cursor=${foreign}`, headers: authHeader("operator") })).json()).toEqual({ items: [], nextCursor: null });
      expect((await app.inject({ url: `${base}/missing/verification-records`, headers: authHeader("operator") })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("atomically rejects pending facilities with evidence and a private audit, then replays without duplicates", async () => {
    const { app, deps } = await setup();
    try {
      await seed(deps, "fac-a");
      const request = { method: "POST", url: `${base}/fac-a/reject`, headers: authHeader("operator"), payload: body };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("private, no-store");
      expect(first.json()).toEqual({ facilityId: "fac-a", verificationStatus: "rejected" });
      expect((await deps.db.doc("facilities/fac-a").get()).data()).toMatchObject({ verificationStatus: "rejected", receivingEnabled: false });
      expect((await app.inject(request)).statusCode).toBe(200);
      const records = await deps.db.collection("facilityVerificationRecords").get();
      expect(records.size).toBe(1);
      expect(records.docs[0]!.data()).toMatchObject({ decision: "rejected", checks, note: "PRIVATE-reason", verifierUid: "operator" });
      const audits = await deps.db.collection("auditEvents").get();
      const rejected = audits.docs.map((doc) => doc.data()).filter((event) => event["action"] === "FACILITY_REJECTED");
      expect(rejected).toHaveLength(1);
      expect(JSON.stringify(rejected)).not.toContain("PRIVATE");
    } finally { await app.close(); }
  });

  it("refuses stale auth, changed status, missing facilities, and invalid review evidence", async () => {
    const { app, deps } = await setup();
    try {
      await seed(deps, "fac-a"); await seed(deps, "fac-verified", "verified");
      for (const payload of [{ ...body, reason: " " }, { ...body, checks: {} }, { ...body, verificationRecordId: "" }]) expect((await app.inject({ method: "POST", url: `${base}/fac-a/reject`, headers: authHeader("operator"), payload })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `${base}/missing/reject`, headers: authHeader("operator"), payload: body })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${base}/fac-verified/reject`, headers: authHeader("operator"), payload: body })).statusCode).toBe(409);
      deps.fakeAuth.authTimeByToken.set("token-operator", 1);
      const stale = await app.inject({ method: "POST", url: `${base}/fac-a/reject`, headers: authHeader("operator"), payload: body });
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error.code).toBe("REAUTH_REQUIRED");
      expect((await deps.db.doc("facilities/fac-a").get()).data()?.["verificationStatus"]).toBe("pending");
    } finally { await app.close(); }
  });
});
