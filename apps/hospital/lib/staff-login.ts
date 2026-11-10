const CREDENTIAL_ERROR = "メールアドレスまたはパスワードが正しくありません。";
const SESSION_ERROR = "セッションを確立できませんでした。時間をおいて再試行してください。";

/** SDKの自由文や内部設定を表示せず、修正可能な案内だけを返す。 */
export function loginErrorMessage(error: unknown, stage: "credentials" | "session" = "credentials"): string {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "";
  if (code === "auth/too-many-requests" || code === "auth/too-many-requests-try-later" || code === "appCheck/throttled") {
    return "試行回数が多すぎます。時間をおいて再試行してください。";
  }
  if (code === "auth/network-request-failed") {
    return "通信できませんでした。接続状態を確認してください。";
  }
  if (code.startsWith("appCheck/")) {
    return "ブラウザの安全性を確認できませんでした。時間をおいて再試行してください。";
  }
  // アカウントの存在・無効化を区別して表示しない。
  if (stage === "credentials" && [
    "auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password",
    "auth/user-not-found", "auth/user-disabled", "auth/invalid-email",
  ].includes(code)) return CREDENTIAL_ERROR;
  return stage === "session" ? SESSION_ERROR : "ログインできませんでした。時間をおいて再試行してください。";
}

/** Cookie確立失敗時は、例外経路も含めFirebaseのサインイン状態を破棄する。 */
export async function completeLoginSession(
  establish: () => Promise<boolean>,
  signOut: () => Promise<void>,
): Promise<string | null> {
  let message = SESSION_ERROR;
  try {
    if (await establish()) return null;
  } catch (error) {
    message = loginErrorMessage(error, "session");
  }
  await signOut().catch(() => undefined);
  return message;
}
