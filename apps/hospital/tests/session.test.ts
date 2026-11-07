import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import {
  assertPortalClient,
  PORTAL_CLIENT_HEADER,
  portalJson,
} from "../lib/session-shared";
import { proxy } from "../proxy";

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
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/facilities");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("proxy: セッションCookieがあれば業務画面を通し、/login では /facilities へ進める", () => {
  const authed = proxy(request("http://localhost:3000/facilities", {}, { "mmr-session": "token" }));
  assert.equal(authed.headers.get("location"), null);
  const login = proxy(request("http://localhost:3000/login", {}, { "mmr-session": "token" }));
  assert.equal(new URL(login.headers.get("location")!).pathname, "/facilities");
});

test("proxy: 公開画面は Cookie 有無に関わらずそのまま通す", () => {
  for (const cookies of [{}, { "mmr-session": "token" }] as Record<string, string>[]) {
    const res = proxy(request("http://localhost:3000/", {}, cookies));
    assert.equal(res.headers.get("location"), null);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  }
});
