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

const cloud = {
  emulator: "false", projectId: "project-7efcc4c4-6c86-490c-ba5",
  apiBaseUrl: "https://api.example.test/v1", apiKey: "public-key", appId: "test-app",
  authDomain: "test.firebaseapp.com", appCheckSiteKey: "public-site-key",
};

test("configured real backend and Firebase Auth/App Check have exact CSP sources", () => {
  const csp = securityHeaders("test-nonce", false, cloud)["Content-Security-Policy"];
  assert.match(csp, /connect-src 'self' https:\/\/api.example.test https:\/\/identitytoolkit.googleapis.com https:\/\/securetoken.googleapis.com https:\/\/content-firebaseappcheck.googleapis.com https:\/\/www.google.com\/recaptcha\/;/);
  assert.match(csp, /frame-src https:\/\/www.google.com\/recaptcha\/ https:\/\/recaptcha.google.com\/recaptcha\/;/);
  assert.match(csp, /upgrade-insecure-requests/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|localhost|\*/);
});

test("invalid settings cannot inject CSP sources or disable HTTPS enforcement", () => {
  for (const patch of [{ apiBaseUrl: "https://bad.test/v1; connect-src *" }, { apiBaseUrl: "http://localhost:8080/v1" }, { apiBaseUrl: "https://user:pass@api.test/v1" }, { emulator: "true" }]) {
    const csp = securityHeaders("test-nonce", false, { ...cloud, ...patch })["Content-Security-Policy"];
    assert.match(csp, /connect-src 'self';/);
    assert.match(csp, /frame-src 'none';/);
    assert.match(csp, /upgrade-insecure-requests/);
    assert.doesNotMatch(csp, /bad.test|localhost|\*/);
  }
});

test("explicit emulator mode allows only the configured loopback origins", () => {
  const csp = securityHeaders("test-nonce", false, { emulator: "true", projectId: "demo-mmr-dev", apiBaseUrl: "http://127.0.0.1:32123/v1", authEmulatorUrl: "http://127.0.0.1:19099" })["Content-Security-Policy"];
  assert.match(csp, /connect-src 'self' http:\/\/127.0.0.1:32123 http:\/\/127.0.0.1:19099;/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests|googleapis.com|localhost|\*/);
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
