import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { initializeApp, deleteApp } from "firebase/app";
import { initializeAuth, connectAuthEmulator, signInWithEmailAndPassword, inMemoryPersistence } from "firebase/auth";
import type { FirebaseHandles } from "../../../services/api/src/firebase";
import { hmacSha256Hex } from "../../../services/api/src/lib/hash";

/** Runs in ordinary test:api/CI, without requiring Chrome or a running portal. */
export async function staffSessionSmoke({ apiBaseUrl, ...fixtures }: {
  firebase: FirebaseHandles; apiBaseUrl: string; facilityId: string;
  otherFacilityId: string; deliveryId: string; hmacSecret: string;
}) {
  assert.equal(process.env.FIREBASE_PROJECT_ID, "demo-mmr-dev");
  assert.match(apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
  assert.match(authHost, /^127\.0\.0\.1:\d+$/);
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "0"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "development", NEXT_PUBLIC_USE_FIREBASE_EMULATOR: "true", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-mmr-dev", NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: `http://${authHost}`, NEXT_PUBLIC_API_BASE_URL: apiBaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Staff portal startup timed out")), 15000);
      next.once("error", () => { clearTimeout(timer); reject(new Error("Staff portal could not start")); });
      next.once("exit", () => { clearTimeout(timer); reject(new Error("Staff portal exited before startup")); });
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address && output.includes("Ready in")) { clearTimeout(timer); resolve(address); }
      };
      next.stdout.on("data", read);
      next.stderr.on("data", read);
    });
    await verifyStaffSession({ ...fixtures, origin });
  } finally {
    if (next.exitCode === null) { const exited = once(next, "exit"); next.kill("SIGTERM"); await exited; }
  }
}

/** Real Next HTTP + Auth/Firestore/API. This does not exercise the MFA login UI. */
async function verifyStaffSession({ firebase, origin, facilityId, otherFacilityId, deliveryId, hmacSecret }: {
  firebase: FirebaseHandles; origin: string; facilityId: string;
  otherFacilityId: string; deliveryId: string; hmacSecret: string;
}) {
  assert.equal(process.env.FIREBASE_PROJECT_ID, "demo-mmr-dev");
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
  assert.match(authHost, /^127\.0\.0\.1:\d+$/);
  const uid = `${facilityId}-session`;
  const email = `${uid}@example.test`;
  const password = "Synthetic-only-session-123!";
  const membership = firebase.firestore.doc(`facilityMemberships/${uid}`);
  const app = initializeApp({ projectId: "demo-mmr-dev", apiKey: "demo-key" }, uid);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const delivery = firebase.firestore.doc(`deliveries/${deliveryId}`);
  const before = (await delivery.get()).data();
  const safeHeaders = { "x-hx-client": "portal", origin, "sec-fetch-site": "same-origin" };
  const noStore = (response: Response) => assert.match(response.headers.get("cache-control") ?? "", /(?:^|[, ])no-store(?:$|[, ])/);
  // Do not include Cookie values or response bodies in assertion diagnostics.
  const noCookie = (response: Response) => assert.ok(response.headers.getSetCookie().length === 0, "Denied request must not issue a Cookie");
  const sessionRequest = (body: unknown, headers: Record<string, string> = safeHeaders) => fetch(`${origin}/api/session`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual",
  });
  try {
    await firebase.auth.createUser({ uid, email, password, emailVerified: true });
    await membership.set({ userUid: uid, facilityId, role: "facility_staff", status: "active" });
    await signInWithEmailAndPassword(auth, email, password);
    const idToken = await auth.currentUser!.getIdToken();
    const listPath = `/api/hx/hospitals/${facilityId}/deliveries`;
    const detailPath = `${listPath}/${deliveryId}`;
    const anonymous = await fetch(`${origin}${listPath}`, { headers: safeHeaders });
    assert.equal(anonymous.status, 401);
    noStore(anonymous);
    for (const headers of [{}, { ...safeHeaders, origin: "https://other.example.test" }, { ...safeHeaders, "sec-fetch-site": "cross-site" }]) {
      const denied = await sessionRequest({ idToken }, headers);
      assert.equal(denied.status, 403);
      noCookie(denied);
      noStore(denied);
    }
    const invalid = await sessionRequest({ idToken: "not-a-valid-id-token" });
    assert.equal(invalid.status, 401);
    noCookie(invalid);
    noStore(invalid);
    const established = await sessionRequest({ idToken });
    assert.equal(established.status, 200);
    noStore(established);
    const sessionCookie = established.headers.getSetCookie().find((value) => value.startsWith("mmr-session="));
    assert.ok(!!sessionCookie, "Real verified token must establish a session");
    for (const attribute of [/; HttpOnly/i, /; SameSite=Strict/i, /; Path=\//i, /; Max-Age=3300/i]) {
      assert.ok(attribute.test(sessionCookie!), "Session must retain its security attributes");
    }
    const cookie = sessionCookie!.split(";")[0]!;
    const portal = (path: string, method = "GET", headers: Record<string, string> = safeHeaders, body?: unknown) => fetch(`${origin}${path}`, {
      method, headers: { ...headers, cookie, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual",
    });
    const ownList = await portal(listPath);
    assert.equal(ownList.status, 200);
    noStore(ownList);
    const list = await ownList.json() as { deliveries: { deliveryId: string }[] };
    assert.ok(list.deliveries.some((item) => item.deliveryId === deliveryId));
    assert.ok(!JSON.stringify(list).includes("SYNTHETIC_QUESTIONNAIRE"));
    const ownDetail = await portal(detailPath);
    assert.equal(ownDetail.status, 200);
    noStore(ownDetail);
    assert.ok((await ownDetail.text()).includes("SYNTHETIC_QUESTIONNAIRE"), "Authorized BFF must return the real questionnaire");
    for (const headers of [{}, { ...safeHeaders, origin: "https://other.example.test" }, { ...safeHeaders, "sec-fetch-site": "cross-site" }]) {
      const denied = await portal(`${detailPath}/acknowledge`, "POST", headers);
      assert.equal(denied.status, 403);
      noStore(denied);
      const logout = await portal("/api/session", "DELETE", headers);
      assert.equal(logout.status, 403);
      noCookie(logout);
    }
    assert.deepEqual((await delivery.get()).data(), before, "Viewing or denied CSRF must not acknowledge the delivery");
    const crossTenant = await portal(`/api/hx/hospitals/${otherFacilityId}/deliveries/${deliveryId}`);
    assert.equal(crossTenant.status, 403);
    noStore(crossTenant);
    assert.ok(!(await crossTenant.text()).includes("SYNTHETIC_QUESTIONNAIRE"));
    const forbiddenContext = await portal("/api/facility-context", "POST", safeHeaders, { facilityId: otherFacilityId });
    assert.equal(forbiddenContext.status, 403);
    noCookie(forbiddenContext);
    const context = await portal("/api/facility-context", "POST", safeHeaders, { facilityId });
    assert.equal(context.status, 200);
    const facilityCookie = context.headers.getSetCookie().find((value) => value.startsWith("mmr-facility="));
    assert.ok(!!facilityCookie);
    const selectedCookie = `${cookie}; ${facilityCookie!.split(";")[0]}`;
    for (const path of ["/deliveries", `/deliveries/${deliveryId}`]) {
      const html = await fetch(`${origin}${path}`, { headers: { cookie: selectedCookie }, redirect: "manual" });
      assert.equal(html.status, 200);
      noStore(html);
      const text = await html.text();
      assert.ok(!text.includes("SYNTHETIC_QUESTIONNAIRE"), "PHI must not enter SSR HTML/RSC");
      assert.ok(!text.includes(idToken), "Credential must not enter SSR HTML/RSC");
    }
    await membership.update({ status: "revoked" });
    const revoked = await portal(detailPath);
    assert.equal(revoked.status, 403);
    noStore(revoked);
    assert.ok(!(await revoked.text()).includes("SYNTHETIC_QUESTIONNAIRE"));
    const logout = await portal("/api/session", "DELETE");
    assert.equal(logout.status, 200);
    noStore(logout);
    for (const name of ["mmr-session", "__Host-mmr-session", "mmr-appcheck", "__Host-mmr-appcheck", "mmr-facility", "__Host-mmr-facility"]) {
      assert.ok(logout.headers.getSetCookie().some((value) => value.startsWith(`${name}=`) && /Expires=Thu, 01 Jan 1970/i.test(value)), "Logout must expire all credential and context Cookies");
    }
  } finally {
    const audit = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hmacSha256Hex(hmacSecret, `audit-res:${deliveryId}`)).get();
    const actorHash = hmacSha256Hex(hmacSecret, `audit-uid:${uid}`);
    await Promise.all(audit.docs.filter((doc) => doc.data().actorUidHash === actorHash).map((doc) => doc.ref.delete()));
    await membership.delete();
    await firebase.auth.deleteUser(uid).catch(() => {});
    await deleteApp(app);
  }
}
