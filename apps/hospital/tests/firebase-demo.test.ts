import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateDemoConfig } from "../lib/firebase-demo";

const valid = { projectId: "demo-mmr-dev", useEmulator: "true", authUrl: "http://localhost:9099", firestoreHost: "localhost:8081", storageHost: "localhost:9199" };
test("accepts only explicit local demo configuration", () => {
  assert.equal(validateDemoConfig(valid).firestore.port, 8081);
  for (const change of [{ projectId: "production" }, { useEmulator: "false" }, { authUrl: undefined }, { authUrl: "https://localhost:9099" }, { firestoreHost: "example.com:8081" }, { storageHost: "localhost:99999" }]) {
    assert.throws(() => validateDemoConfig({ ...valid, ...change }));
  }
});
