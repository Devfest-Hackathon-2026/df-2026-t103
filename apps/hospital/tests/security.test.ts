import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { proxy, securityHeaders } from "../proxy";

test("production blocks inline/eval scripts and external connections", () => {
  const headers = securityHeaders("test-nonce", false);
  const csp = headers["Content-Security-Policy"];
  assert.match(csp, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/);
  assert.match(csp, /connect-src 'self';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|localhost|https:\/\/\*/);
  assert.match(headers["Cache-Control"], /no-store/);
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

test("development supports local HMR without imposing HTTPS on localhost", () => {
  const headers = securityHeaders("test-nonce", true);
  assert.match(headers["Content-Security-Policy"], /unsafe-eval/);
  assert.doesNotMatch(headers["Content-Security-Policy"], /upgrade-insecure-requests/);
  assert.equal(headers["Strict-Transport-Security"], undefined);
});

test("each request replaces attacker supplied nonce and CSP", () => {
  const request = new NextRequest("http://localhost/", { headers: {
    "x-nonce": "attacker", "content-security-policy": "script-src 'unsafe-inline'",
  } });
  const first = proxy(request);
  const second = proxy(request);
  const nonce = first.headers.get("x-middleware-request-x-nonce");
  assert.match(nonce!, /^[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(nonce, second.headers.get("x-middleware-request-x-nonce"));
  assert.ok(first.headers.get("Content-Security-Policy")?.includes(`'nonce-${nonce}'`));
  assert.equal(first.headers.get("x-middleware-request-content-security-policy"), first.headers.get("Content-Security-Policy"));
  assert.doesNotMatch(first.headers.get("Content-Security-Policy")!, /attacker/);
  assert.equal(first.cookies.getAll().length, 0);
});
