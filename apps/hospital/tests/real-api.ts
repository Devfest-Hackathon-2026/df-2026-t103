import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import { initializeApp, deleteApp } from "firebase/app";
import { initializeAuth, connectAuthEmulator, signInWithEmailAndPassword, inMemoryPersistence } from "firebase/auth";
import { loadConfig } from "../../../services/api/src/config";
import { initFirebase } from "../../../services/api/src/firebase";
import { createApiClient } from "../lib/api-client";
import { browserSmoke } from "./browser-smoke.mjs";

test("hospital client uses real Auth + Firestore + Fastify routes (no API stub)", { timeout: 90000 }, async () => {
  assert.equal(process.env.FIREBASE_PROJECT_ID, "demo-mmr-dev");
  for (const key of ["FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "FIREBASE_DATABASE_EMULATOR_HOST"]) assert.match(process.env[key] ?? "", /^127\.0\.0\.1:\d+$/);
  const firebase = initFirebase(loadConfig());
  const uid = `hospital-connection-${Date.now()}`;
  const email = `${uid}@example.test`;
  const password = "Synthetic-only-connection-123!";
  const membership = firebase.firestore.doc(`facilityMemberships/${uid}`);
  const job = firebase.firestore.doc(`ocrJobs/${uid}`);
  const app = initializeApp({ projectId: "demo-mmr-dev", apiKey: "demo-key" }, uid);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("../../../services/api/", import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LOG_LEVEL: "info", API_CORS_ORIGINS: "http://localhost:3000,http://127.0.0.1:33090" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Real BE startup timed out")), 20000);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Real BE exited before startup")); });
      child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("Server listening")) { clearTimeout(timer); resolve(); } });
      child.stderr.on("data", () => { /* Never print runtime credentials or data. */ });
    });
    await firebase.auth.createUser({ uid, email, password, emailVerified: true });
    await signInWithEmailAndPassword(auth, email, password);
    const api = createApiClient({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, emulator: true, idToken: () => auth.currentUser!.getIdToken(), appCheckToken: async () => null });
    await assert.rejects(api.jobFailures("ocr"), { status: 403 });
    await membership.set({ userUid: uid, facilityId: "synthetic-facility", role: "platform_security_admin", status: "active" });
    await job.set({ status: "failed", errorCode: "engine_unavailable", attempt: 2, updatedAt: new Date(), patientUid: "SYNTHETIC_PRIVATE_VALUE" });
    const page = await api.jobFailures("ocr");
    assert.ok(page.items.some((item) => item.failureCode === "engine_unavailable" && item.attempts === 2));
    assert.ok(!JSON.stringify(page).includes("SYNTHETIC_PRIVATE_VALUE"));
    assert.ok(!JSON.stringify(page).includes(uid), "BE must pseudonymize the legacy job ID");
    if (process.env.HOSPITAL_BROWSER_SMOKE === "true") await browserSmoke({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, authHost: process.env.FIREBASE_AUTH_EMULATOR_HOST!, email, password });
    await membership.update({ status: "revoked" });
    await assert.rejects(api.jobFailures("ocr"), { status: 403 });
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/operator/job-failures?type=ocr`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await Promise.all([membership.delete(), job.delete(), firebase.auth.deleteUser(uid).catch(() => {})]);
    await deleteApp(app);
    await firebase.firestore.terminate();
    const { deleteApp: deleteAdminApp } = createRequire(new URL("../../../services/api/package.json", import.meta.url))("firebase-admin/app") as { deleteApp: (app: unknown) => Promise<void> };
    await deleteAdminApp(firebase.app);
  }
});
