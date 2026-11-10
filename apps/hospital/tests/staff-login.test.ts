import assert from "node:assert/strict";
import { test } from "node:test";
import { completeLoginSession, loginErrorMessage } from "../lib/staff-login";

test("credential failures do not disclose account existence or disabled status", () => {
  for (const code of ["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found", "auth/user-disabled", "auth/invalid-email"]) {
    assert.equal(loginErrorMessage({ code }), "メールアドレスまたはパスワードが正しくありません。");
  }
});

test("App Check failures are distinct from credentials and never expose SDK text", () => {
  for (const code of ["appCheck/fetch-status-error", "appCheck/recaptcha-error", "appCheck/future-error"]) {
    assert.equal(loginErrorMessage({ code, message: "SYNTHETIC_PRIVATE_VALUE" }), "ブラウザの安全性を確認できませんでした。時間をおいて再試行してください。");
  }
  assert.match(loginErrorMessage({ code: "appCheck/throttled" }), /試行回数/);
  assert.match(loginErrorMessage({ code: "auth/too-many-requests" }), /試行回数/);
  assert.match(loginErrorMessage({ code: "auth/network-request-failed" }), /接続状態/);
});

test("unknown errors use safe stage-specific messages", () => {
  for (const error of [null, undefined, "SYNTHETIC_PRIVATE_VALUE", new Error("SYNTHETIC_PRIVATE_VALUE"), { code: 403 }]) {
    assert.equal(loginErrorMessage(error), "ログインできませんでした。時間をおいて再試行してください。");
    assert.equal(loginErrorMessage(error, "session"), "セッションを確立できませんでした。時間をおいて再試行してください。");
  }
});

test("successful session keeps the signed-in user", async () => {
  let signOuts = 0;
  assert.equal(await completeLoginSession(async () => true, async () => { signOuts++; }), null);
  assert.equal(signOuts, 0);
});

test("denied session and token/network exceptions all clear Firebase sign-in", async () => {
  for (const failure of [false, { code: "appCheck/fetch-status-error" }, new TypeError("fetch failed"), { code: "auth/user-token-expired" }]) {
    let signedIn = true;
    const result = await completeLoginSession(async () => {
      if (failure === false) return false;
      throw failure;
    }, async () => { signedIn = false; });
    assert.equal(signedIn, false);
    assert.notEqual(result, null);
    assert.doesNotMatch(result!, /パスワード|fetch failed/);
  }
});

test("cleanup rejection cannot hide the original safe error or allow navigation", async () => {
  const result = await completeLoginSession(async () => { throw { code: "appCheck/throttled" }; }, async () => { throw new Error("SYNTHETIC_PRIVATE_VALUE"); });
  assert.equal(result, "試行回数が多すぎます。時間をおいて再試行してください。");
});
