import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import {
  assertPortalClient,
  PORTAL_CLIENT_HEADER,
  portalJson,
} from "../lib/session-shared";
import { portalRedirect } from "../lib/portal-redirect";
import { proxy } from "../proxy";
import { FACILITY_ID_PATTERN, facilityCookieName } from "../lib/facility-shared";

// テスト実行時に clientConfig() が読む環境変数（Emulator向けの明示設定）
process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR ??= "true";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= "demo-mmr-dev";
process.env.NEXT_PUBLIC_API_BASE_URL ??= "http://localhost:8080/v1";
process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL ??= "http://localhost:9099";

function request(
  url: string,
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
): NextRequest {
  const req = new NextRequest(url, { headers });
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

const valid = { [PORTAL_CLIENT_HEADER]: "portal", host: "portal.test" };

test("CSRF: 必須ヘッダー・サイト内由来・同一オリジンの三重確認", () => {
  assert.equal(assertPortalClient(request("https://portal.test/api/session"))?.status, 403);
  assert.equal(
    assertPortalClient(request("https://portal.test/api/session", valid))?.status ?? 200,
    200,
  );
  assert.equal(
    assertPortalClient(
      request("https://portal.test/api/session", { ...valid, "sec-fetch-site": "cross-site" }),
    )?.status,
    403,
  );
  assert.equal(
    assertPortalClient(
      request("https://portal.test/api/session", { ...valid, origin: "https://evil.example" }),
    )?.status,
    403,
  );
  assert.equal(
    assertPortalClient(
      request("https://portal.test/api/session", { ...valid, origin: "not-a-url" }),
    )?.status,
    403,
  );
  assert.equal(
    assertPortalClient(
      request("https://portal.test/api/session", { ...valid, origin: "https://portal.test", "sec-fetch-site": "same-origin" }),
    )?.status ?? 200,
    200,
  );
});

test("portalJson は no-store を付けて PHI の共有キャッシュを防ぐ", async () => {
  const res = portalJson({ ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.status, 200);
});

test("proxy: 未ログインで業務画面へ行くと /login?next= へ戻される", () => {
  const res = proxy(request("http://localhost:3000/facilities"));
  assert.equal(res.status, 307);
  const location = new URL(res.headers.get("location")!, "https://public.example.test");
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/facilities");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("proxy: セッションCookieがあれば業務画面を通し、/login では /facilities へ進める", () => {
  const authed = proxy(request("http://localhost:3000/facilities", {}, { "mmr-session": "token" }));
  assert.equal(authed.headers.get("location"), null);
  const login = proxy(request("http://localhost:3000/login", {}, { "mmr-session": "token" }));
  assert.equal(new URL(login.headers.get("location")!, "https://public.example.test").pathname, "/facilities");
});

test("施設コンテキスト: Cookie名とID検証", () => {
  assert.equal(facilityCookieName(), "mmr-facility");
  for (const ok of ["fac-001", "abc_DEF-123"]) assert.ok(FACILITY_ID_PATTERN.test(ok));
  for (const bad of ["", "a".repeat(129), "fac/..", "施設", "a b"]) {
    assert.ok(!FACILITY_ID_PATTERN.test(bad));
  }
});

test("proxy: 公開画面は Cookie 有無に関わらずそのまま通す", () => {
  for (const cookies of [{}, { "mmr-session": "token" }] as Record<string, string>[]) {
    const res = proxy(request("http://localhost:3000/", {}, cookies));
    assert.equal(res.headers.get("location"), null);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  }
});


test("redirects retain configured public origin with internal URLs and hostile forwarded hosts", () => {
  const previous = process.env.HOSPITAL_PUBLIC_ORIGIN;
  process.env.HOSPITAL_PUBLIC_ORIGIN = "https://public.example.test";
  try {
    const headers = { host: "0.0.0.0:8080", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" };
    const denied = proxy(request("http://0.0.0.0:8080/deliveries?status=delivered", headers));
    assert.equal(denied.headers.get("location"), "https://public.example.test/login?next=%2Fdeliveries%3Fstatus%3Ddelivered");
    const signedIn = proxy(request("http://0.0.0.0:8080/login", headers, { "mmr-session": "synthetic-token" }));
    assert.equal(signedIn.headers.get("location"), "https://public.example.test/facilities");
  } finally {
    if (previous === undefined) delete process.env.HOSPITAL_PUBLIC_ORIGIN;
    else process.env.HOSPITAL_PUBLIC_ORIGIN = previous;
  }
});


test("production redirects fail closed for missing or malformed configured origin", () => {
  const previousOrigin = process.env.HOSPITAL_PUBLIC_ORIGIN;
  const previousNodeEnv = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    delete process.env.HOSPITAL_PUBLIC_ORIGIN;
    assert.throws(() => portalRedirect("http://0.0.0.0:8080/", "/login"), /required/);
    for (const origin of ["http://public.example.test", "https://user:pass@public.example.test", "https://public.example.test/path", "https://public.example.test?query=1", "https://public.example.test#fragment"]) {
      process.env.HOSPITAL_PUBLIC_ORIGIN = origin;
      assert.throws(() => portalRedirect("http://0.0.0.0:8080/", "/login"), /HTTPS origin/);
    }
  } finally {
    if (previousOrigin === undefined) delete process.env.HOSPITAL_PUBLIC_ORIGIN;
    else process.env.HOSPITAL_PUBLIC_ORIGIN = previousOrigin;
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: previousNodeEnv });
  }
});
