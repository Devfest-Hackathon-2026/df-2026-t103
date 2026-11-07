import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiClient } from "../lib/api-client";
import { parseReviewFacilities, parseVerificationSummaries } from "../lib/facility-review";

const checks = { existence: true, applicant: true, receiverContact: true, location: true };
test("facility and evidence parsers whitelist fields rather than exposing private records", () => {
  const facility = { facilityId: "facility-1", legalName: "合成施設", displayName: "合成施設", verificationStatus: "pending", receivingEnabled: false, createdAt: null };
  assert.deepEqual(parseReviewFacilities({ items: [{ ...facility, contactChannel: "PRIVATE", verificationRecordId: "PRIVATE" }], nextCursor: null }), { items: [facility], nextCursor: null });
  const record = { recordId: `vr_${"a".repeat(64)}`, decision: "verified", checks, createdAt: null };
  assert.deepEqual(parseVerificationSummaries({ items: [{ ...record, verifierUid: "PRIVATE", note: "PRIVATE", verificationRecordId: "PRIVATE", checks: { ...checks, patient: "PRIVATE" } }], nextCursor: null }), { items: [record], nextCursor: null });
  assert.throws(() => parseReviewFacilities({ items: [{ ...facility, verificationStatus: "invented" }], nextCursor: null }));
  assert.throws(() => parseVerificationSummaries({ items: [{ ...record, checks: {} }], nextCursor: null }));
  assert.throws(() => parseVerificationSummaries({ items: [{ ...record, recordId: "raw-document-id" }], nextCursor: null }));
});

test("review client blocks incomplete approvals and sends authenticated explicit decisions", async (t) => {
  const api = createApiClient({ apiBaseUrl: "https://invalid.example/v1", emulator: false, idToken: async () => "synthetic-token", appCheckToken: async () => "synthetic-appcheck" });
  let calls = 0;
  let status = "verified";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, `https://invalid.example/v1/operator/facilities/facility-1/${status === "verified" ? "verify" : "reject"}`);
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Authorization: "Bearer synthetic-token", "X-Firebase-AppCheck": "synthetic-appcheck", "Content-Type": "application/json" });
    const body = JSON.parse(String(options.body));
    assert.equal(body.verificationRecordId, "synthetic-reference");
    assert.equal(body.reason, status === "rejected" ? "synthetic-reason" : undefined);
    return Response.json({ facilityId: "facility-1", verificationStatus: status });
  });
  await assert.rejects(api.reviewFacility("facility-1", "verified", { checks: { ...checks, applicant: false }, verificationRecordId: "synthetic-reference" }));
  await assert.rejects(api.reviewFacility("facility-1", "rejected", { checks, verificationRecordId: "synthetic-reference", reason: " " }));
  assert.equal(calls, 0);
  await api.reviewFacility("facility-1", "verified", { checks, verificationRecordId: "synthetic-reference" });
  status = "rejected";
  await api.reviewFacility("facility-1", "rejected", { checks, verificationRecordId: "synthetic-reference", reason: "synthetic-reason" });
});

test("review client rejects mismatched success and exposes only a known reauth error", async (t) => {
  const api = createApiClient({ apiBaseUrl: "https://invalid.example/v1", emulator: true, idToken: async () => "token", appCheckToken: async () => null });
  let response = Response.json({ facilityId: "different-facility", verificationStatus: "verified" });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(api.reviewFacility("facility-1", "verified", { checks, verificationRecordId: "synthetic-reference" }));
  response = Response.json({ error: { code: "REAUTH_REQUIRED", message: "PRIVATE" } }, { status: 403 });
  await assert.rejects(api.reviewFacility("facility-1", "verified", { checks, verificationRecordId: "synthetic-reference" }), (error: Error) => {
    assert.match(error.message, /再認証/); assert.doesNotMatch(error.message, /PRIVATE/); return true;
  });
});
