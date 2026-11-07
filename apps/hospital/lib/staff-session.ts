import { firebaseClient } from "./firebase-client";
import { clientConfig } from "./client-config";

/** クライアント側で Firebase サインイン済みの状態から、サーバのセッション Cookie を確立する。 */
export async function establishSession(): Promise<boolean> {
  const client = firebaseClient();
  const user = client.auth.currentUser;
  if (!user) return false;
  if (!clientConfig().emulator) {
    // 職員の本番認証はMFA済みトークンのみ許可（NFR-05）。credential をCookieにしない。
    // MFA登録直後も最新クレームを得るため強制リフレッシュする。
    const result = await user.getIdTokenResult(true);
    if (!(result.claims.firebase as { sign_in_second_factor?: string } | undefined)
      ?.sign_in_second_factor) {
      return false;
    }
  }
  const tokens = await client.sessionTokens();
  if (!tokens.idToken) return false;
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hx-client": "portal" },
    body: JSON.stringify(tokens),
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  return response.ok;
}

/** セッション Cookie と Firebase サインイン状態を両方破棄する。 */
export async function destroySession(): Promise<void> {
  await fetch("/api/session", {
    method: "DELETE",
    headers: { "x-hx-client": "portal" },
    credentials: "same-origin",
    redirect: "error",
  }).catch(() => undefined);
}
