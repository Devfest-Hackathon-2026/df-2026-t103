import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiClient, parseJobFailurePage } from "../lib/api-client";
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
});
