import { portalRedirect } from "./lib/portal-redirect";
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { validateClientConfig, type ClientConfigInput } from "./lib/client-config";
import {
  PATHNAME_HEADER,
  SESSION_COOKIE_DEV,
  SESSION_COOKIE_PROD,
  sessionCookieName,
} from "./lib/session-shared";

function serviceSources(input: ClientConfigInput) {
  try {
    const config = validateClientConfig(input);
    if (config.emulator) return {
      emulator: true,
      connect: [new URL(config.apiBaseUrl).origin, new URL(config.authEmulatorUrl!).origin],
      frames: [],
    };
    return {
      emulator: false,
      connect: [new URL(config.apiBaseUrl).origin, "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://content-firebaseappcheck.googleapis.com", "https://www.google.com/recaptcha/"],
      frames: ["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"],
    };
  } catch {
    // Invalid/missing connection settings must never widen the policy.
    // The client displays the configuration error when login is attempted.
    return { emulator: false, connect: [], frames: [] };
  }
}

export function securityHeaders(nonce: string, development: boolean, input: ClientConfigInput = {}) {
  const sources = serviceSources(input);
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${["'self'", ...new Set(sources.connect), ...(development ? ["ws://localhost:*", "ws://127.0.0.1:*"] : [])].join(" ")}`,
    `frame-src ${sources.frames.length ? sources.frames.join(" ") : "'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!development && !sources.emulator ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...(!development ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}

/** (workspace) グループ配下の業務ページ。セッションCookieの有無で楽観的に振り分ける。 */
const PROTECTED_PREFIXES = ["/facilities", "/deliveries", "/staff", "/settings"];

/**
 * セキュリティヘッダー付与（#90）＋楽観的認証ガード（H-001）。
 * Cookieの有無だけを見て素早くリダイレクトし、本検証はページ側の
 * (workspace)/layout.tsx が API 経由で行う（Proxyは認可の正本にしない）。
 * no-store は securityHeaders 側で全レスポンスに付与される。
 */
export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString("base64");
  const headers = securityHeaders(nonce, process.env.NODE_ENV === "development", {
    emulator: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appCheckSiteKey: process.env.NEXT_PUBLIC_APP_CHECK_SITE_KEY,
    authEmulatorUrl: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL,
  });
  const { pathname, search } = request.nextUrl;
  // 環境で有効なCookie名・非空値だけを見る（旧名・空値の残留Cookieによるガードループを防ぐ）
  // 設定不全でも Proxy 自体は落とさず両方のCookie名を確認する
  let hasSession = false;
  try {
    hasSession = Boolean(request.cookies.get(sessionCookieName())?.value);
  } catch {
    hasSession = Boolean(
      request.cookies.get(SESSION_COOKIE_PROD)?.value ||
        request.cookies.get(SESSION_COOKIE_DEV)?.value,
    );
  }
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  // レイアウトが next パラメータ復元に使う内部ヘッダーとCSP nonceを常時付与する
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATHNAME_HEADER, `${pathname}${search}`);
  // Overwrite untrusted client headers before Next.js extracts the script nonce.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]);
  const pass = () => NextResponse.next({ request: { headers: requestHeaders } });

  let response: NextResponse;
  if (isProtected && !hasSession) {
    response = portalRedirect(request.url, "/login", new URLSearchParams({ next: `${pathname}${search}` }));
  } else if (pathname === "/login" && hasSession) {
    response = portalRedirect(request.url, "/facilities");
  } else {
    response = pass();
  }
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

export const config = {
  // Also protect RSC, prefetch, errors and routes with file-like names.
  matcher: ["/((?!_next/static/).*)"],
};
