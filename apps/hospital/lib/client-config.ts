export type ClientConfigInput = {
  emulator?: string; projectId?: string; apiBaseUrl?: string; apiKey?: string;
  appId?: string; authDomain?: string; appCheckSiteKey?: string; authEmulatorUrl?: string;
};

function localUrl(value: string) {
  const url = new URL(value);
  return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && !url.username && !url.password;
}

export function validateClientConfig(input: ClientConfigInput) {
  if (!["true", "false"].includes(input.emulator ?? "") || !input.apiBaseUrl || !input.projectId) throw new Error("FirebaseとAPIの接続設定が必要です。");
  const emulator = input.emulator === "true";
  const url = new URL(input.apiBaseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") throw new Error("APIの接続先は/v1までのURLで指定してください。");
  if (emulator) {
    if (input.projectId !== "demo-mmr-dev" || !localUrl(input.apiBaseUrl) || !input.authEmulatorUrl || !localUrl(input.authEmulatorUrl) || new URL(input.authEmulatorUrl).pathname !== "/") throw new Error("ローカルEmulatorの接続設定が不正です。");
  } else if (input.projectId !== "project-7efcc4c4-6c86-490c-ba5" || url.protocol !== "https:" || !input.apiKey || !input.appId || !input.authDomain || !input.appCheckSiteKey || input.authEmulatorUrl) {
    throw new Error("実環境のFirebase・App Check・HTTPS APIの設定が必要です。");
  }
  return {
    emulator, apiBaseUrl: input.apiBaseUrl.replace(/\/$/, ""),
    projectId: input.projectId, apiKey: emulator ? "demo-key" : input.apiKey!,
    appId: emulator ? "demo-hospital" : input.appId!,
    authDomain: input.authDomain, appCheckSiteKey: input.appCheckSiteKey,
    authEmulatorUrl: input.authEmulatorUrl,
  };
}

export function clientConfig() {
  return validateClientConfig({
    emulator: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appCheckSiteKey: process.env.NEXT_PUBLIC_APP_CHECK_SITE_KEY,
    authEmulatorUrl: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL,
  });
}
