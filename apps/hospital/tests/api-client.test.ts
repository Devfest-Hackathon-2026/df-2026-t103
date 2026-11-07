import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiClient, parseJobFailurePage, parseAuditSummaryPage } from "../lib/api-client";
import { validateClientConfig } from "../lib/client-config";

const local = { emulator: "true", projectId: "demo-mmr-dev", apiBaseUrl: "http://localhost:8080/v1", authEmulatorUrl: "http://localhost:9099" };
test("API config fails closed rather than silently switching to mocks or production", () => {
  assert.equal(validateClientConfig(local).emulator, true);
  for (const patch of [{ projectId: "real-project" }, { apiBaseUrl: "https://example.com/v1" }, { authEmulatorUrl: "https://example.com" }, { emulator: undefined }, { apiBaseUrl: "http://localhost:8080/v1?token=bad" }]) assert.throws(() => validateClientConfig({ ...local, ...patch }));
  assert.throws(() => validateClientConfig({ ...local, emulator: "false", projectId: "project-7efcc4c4-6c86-490c-ba5" }));
  assert.equal(validateClientConfig({ emulator: "false", projectId: "project-7efcc4c4-6c86-490c-ba5", apiBaseUrl: "https://api.example.com/v1", apiKey: "public-key", appId: "test-app", authDomain: "test.firebaseapp.com", appCheckSiteKey: "public-site-key" }).emulator, false);
});

test("job page rejects malformed data and removes unknown private fields", () => {
  const item = { type: "ocr", jobId: "synthetic-job", failureCode: "engine_unavailable", attempts: 2, failedAt: null };
  assert.deepEqual(parseJobFailurePage({ items: [{ ...item, patientUid: "PRIVATE" }], nextCursor: null }), { items: [item], nextCursor: null });
  for (const value of [{}, { items: [{}], nextCursor: null }, { items: [{ ...item, attempts: -1 }], nextCursor: null }, { items: [], nextCursor: 3 }]) assert.throws(() => parseJobFailurePage(value));
});

test("production requires both credentials before issuing a network request", async () => {
  const api = createApiClient({ apiBaseUrl: "https://invalid.example/v1", emulator: false, idToken: async () => "id-token", appCheckToken: async () => null });
  await assert.rejects(api.jobFailures("ocr"), { status: 401 });
  await assert.rejects(api.auditEvents(), { status: 401 });
  await assert.rejects(api.disableFacility("synthetic-facility", "drill"), { status: 401 });
});

test("emergency stop validates input, authenticates POST, and checks server confirmation", async (t) => {
  const api = createApiClient({ apiBaseUrl: "https://invalid.example/v1", emulator: false, idToken: async () => "synthetic-token", appCheckToken: async () => "synthetic-appcheck" });
  let calls = 0;
  let response = { facilityId: "facility-1", receivingEnabled: false };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, "https://invalid.example/v1/operator/facilities/facility-1/disable");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Authorization: "Bearer synthetic-token", "X-Firebase-AppCheck": "synthetic-appcheck", "Content-Type": "application/json" });
    assert.equal(options.body, JSON.stringify({ reason: "drill" }));
    return Response.json(response);
  });
  for (const [id, reason] of [["../other", "drill"], ["facility-1", " "], ["facility-1", "a".repeat(501)]]) await assert.rejects(api.disableFacility(id, reason));
  assert.equal(calls, 0);
  await api.disableFacility("facility-1", " drill ");
  response = { facilityId: "different-facility", receivingEnabled: false };
  await assert.rejects(api.disableFacility("facility-1", "drill"));
  response = { facilityId: "facility-1", receivingEnabled: true };
  await assert.rejects(api.disableFacility("facility-1", "drill"));
});

test("emergency stop reports fresh-auth failure without disclosing server error fields or retrying", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: { code: "REAUTH_REQUIRED", message: "PRIVATE_SERVER_MESSAGE" } }, { status: 403 });
  });
  const api = createApiClient({ apiBaseUrl: "https://invalid.example/v1", emulator: true, idToken: async () => "synthetic-token", appCheckToken: async () => null });
  await assert.rejects(api.disableFacility("facility-1", "drill"), (error: Error) => {
    assert.match(error.message, /再認証/);
    assert.doesNotMatch(error.message, /PRIVATE_SERVER_MESSAGE/);
    return true;
  });
  assert.equal(calls, 1);
});

test("audit summary strips private fields and rejects malformed operational metadata", () => {
  const item = { eventId: `ae_${"a".repeat(64)}`, action: "STAFF_MEMBERSHIP_UPDATED", actorType: "staff", occurredAt: "2026-01-01T00:00:00.000Z", decision: null, outcome: "success" };
  assert.deepEqual(parseAuditSummaryPage({ items: [{ ...item, details: "PRIVATE", actorUidHash: "PRIVATE", facilityId: "PRIVATE" }], nextCursor: null }), { items: [item], nextCursor: null });
  for (const patch of [{ actorType: "PRIVATE" }, { outcome: "PRIVATE" }, { eventId: "raw-id" }, { decision: "PRIVATE" }, { occurredAt: "bad date" }, { action: "<script>" }]) assert.throws(() => parseAuditSummaryPage({ items: [{ ...item, ...patch }], nextCursor: null }));
});
