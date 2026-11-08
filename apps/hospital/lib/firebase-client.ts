import { initializeApp } from "firebase/app";
import { connectAuthEmulator, initializeAuth, inMemoryPersistence } from "firebase/auth";
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { clientConfig } from "./client-config";
import { createApiClient } from "./api-client";

let cached: ReturnType<typeof initialize> | undefined;

function initialize() {
  const config = clientConfig();
  const app = initializeApp({ projectId: config.projectId, apiKey: config.apiKey, appId: config.appId, authDomain: config.authDomain }, "hospital-api");
  const appCheck = config.emulator ? null : initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey!), isTokenAutoRefreshEnabled: true,
  });
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  // Match the Japanese portal when Firebase sends password-reset emails.
  auth.languageCode = "ja";
  if (config.emulator) connectAuthEmulator(auth, config.authEmulatorUrl!, { disableWarnings: true });
  const api = createApiClient({
    apiBaseUrl: config.apiBaseUrl, emulator: config.emulator,
    idToken: async () => {
      const user = auth.currentUser;
      if (!user) throw new Error("ログインしてください。");
      // This check is additional UX gating; the backend remains authoritative.
      // Never present a password-only production sign-in as staff MFA.
      const result = await user.getIdTokenResult();
      if (!config.emulator && !(result.claims.firebase as { sign_in_second_factor?: string } | undefined)?.sign_in_second_factor) throw new Error("職員MFAが必要です。管理者に設定を確認してください。");
      return result.token;
    },
    appCheckToken: async () => appCheck ? (await getToken(appCheck)).token : null,
  });
  return {
    auth,
    api,
    /** セッション確立・更新用の生トークン取得。API 呼び出しには api を使う。 */
    sessionTokens: async () => ({
      idToken: auth.currentUser ? await auth.currentUser.getIdToken() : null,
      appCheckToken: appCheck ? (await getToken(appCheck)).token : null,
    }),
  };
}

export function firebaseClient() {
  cached ??= initialize();
  return cached;
}
