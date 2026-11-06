import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const local = {
  FIREBASE_PROJECT_ID: "demo-mmr-dev",
  FIRESTORE_EMULATOR_HOST: "firebase:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "firebase:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "firebase:9199",
  FIREBASE_DATABASE_EMULATOR_HOST: "firebase:9000",
  FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: "localhost:9199",
};

describe("Firebase connection configuration", () => {
  it("accepts the Compose emulator configuration", () => {
    expect(loadConfig(local)).toMatchObject({
      projectId: "demo-mmr-dev", emulator: true, appCheckMode: "permissive",
    });
  });

  it("accepts a cloud configuration with production safeguards", () => {
    expect(loadConfig({
      NODE_ENV: "production", FIREBASE_PROJECT_ID: "real-project",
      SERVER_HMAC_SECRET: "test-secret",
    })).toMatchObject({ emulator: false, appCheckMode: "enforce", apiDocsEnabled: false });
  });

  it.each([
    "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST",
    "FIREBASE_STORAGE_EMULATOR_HOST", "FIREBASE_DATABASE_EMULATOR_HOST",
  ] as const)("rejects missing or empty %s", (key) => {
    const missing: NodeJS.ProcessEnv = { ...local };
    delete missing[key];
    expect(() => loadConfig(missing)).toThrow();
    expect(() => loadConfig({ ...local, [key]: "  " })).toThrow();
  });

  it("rejects either Auth or Firestore alone", () => {
    expect(() => loadConfig({ FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" })).toThrow();
    expect(() => loadConfig({ FIRESTORE_EMULATOR_HOST: "localhost:8080" })).toThrow();
  });

  it.each(["example.com:9099", "firebase.googleapis.com:443", "localhost:0", "localhost:65536", "http://localhost:9099"])("rejects unsafe or invalid emulator host %s", (host) => {
    expect(() => loadConfig({ ...local, FIREBASE_AUTH_EMULATOR_HOST: host })).toThrow();
  });

  it("rejects real projects with emulators and demo projects without them", () => {
    expect(() => loadConfig({ ...local, FIREBASE_PROJECT_ID: "real-project" })).toThrow();
    expect(() => loadConfig({ FIREBASE_PROJECT_ID: "demo-mmr-dev" })).toThrow();
    expect(() => loadConfig({})).toThrow();
  });

  it("rejects conflicting project IDs and unsupported RTDB legacy configuration", () => {
    expect(() => loadConfig({ ...local, GCLOUD_PROJECT: "real-project" })).toThrow();
    expect(() => loadConfig({ ...local, DATABASE_EMULATOR_HOST: "firebase:9000" })).toThrow();
  });

  it("rejects a public Storage host outside emulator mode or an empty one", () => {
    expect(() => loadConfig({ FIREBASE_PROJECT_ID: "real-project", FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: "localhost:9199" })).toThrow();
    expect(() => loadConfig({ ...local, FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: "" })).toThrow();
  });

  it("accepts a loopback public Storage host for the browser", () => {
    expect(loadConfig({ ...local, FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: "127.0.0.1:9199" }))
      .toMatchObject({ emulator: true, storageEmulatorPublicHost: "127.0.0.1:9199" });
  });

  it("requires a loopback public Storage host when the internal host is Compose DNS", () => {
    const { FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: _publicHost, ...withoutPublic } = local;
    expect(() => loadConfig(withoutPublic)).toThrow("public host is required");
    expect(loadConfig({ ...withoutPublic, FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" }).emulator).toBe(true);
  });

  it.each([
    "example.com:9199", "firebase.googleapis.com:443", "firebase:9199",
    "http://localhost:9199", "localhost:0", "localhost:65536", " localhost:9199",
  ])("rejects non-browser-reachable or invalid public Storage host %s", (host) => {
    expect(() => loadConfig({ ...local, FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST: host })).toThrow();
  });

  it("still requires a production secret for cloud mode", () => {
    expect(() => loadConfig({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "real-project" })).toThrow("SERVER_HMAC_SECRET");
  });
});
