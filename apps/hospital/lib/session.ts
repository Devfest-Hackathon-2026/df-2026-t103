import "server-only";
import { cookies } from "next/headers";
import { clientConfig } from "./client-config";
import {
  appCheckCookieName,
  APPCHECK_COOKIE_DEV,
  APPCHECK_COOKIE_PROD,
  sessionCookieName,
  SESSION_COOKIE_DEV,
  SESSION_COOKIE_PROD,
} from "./session-shared";
import { FACILITY_COOKIE_DEV, FACILITY_COOKIE_PROD } from "./facility-shared";

export {
  assertPortalClient,
  portalJson,
  PORTAL_CLIENT_HEADER,
} from "./session-shared";

/**
 * 職員ポータルのセッション Cookie 基盤（H-001, NFR-05）。
 *
 * `mmr_session` に Firebase ID トークンを HttpOnly で保持し、
 * ページガードと `/api/hx/*` BFF 経由の API 認証に使う。
 * Cookie 自体は credential であり、実際の検証は API 側の
 * verifyIdToken + facilityMemberships 照合が行う。
 */

/** ID トークン寿命（約60分）より少し短くし、失効済み credential を残さない。 */
const SESSION_MAX_AGE_SECONDS = 55 * 60;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: !clientConfig().emulator,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export interface StaffSession {
  idToken: string;
  appCheckToken: string | null;
}

export async function readSession(): Promise<StaffSession | null> {
  const jar = await cookies();
  const idToken = jar.get(sessionCookieName())?.value;
  if (!idToken) return null;
  return {
    idToken,
    appCheckToken: jar.get(appCheckCookieName())?.value ?? null,
  };
}

export async function writeSession(session: StaffSession): Promise<void> {
  const jar = await cookies();
  jar.set(sessionCookieName(), session.idToken, cookieOptions());
  if (session.appCheckToken) {
    jar.set(appCheckCookieName(), session.appCheckToken, cookieOptions());
  } else {
    jar.delete(appCheckCookieName());
  }
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  // 環境名の違いで残った旧Cookieも確実に消す（ガードループ防止）
  for (const name of [
    SESSION_COOKIE_PROD,
    SESSION_COOKIE_DEV,
    APPCHECK_COOKIE_PROD,
    APPCHECK_COOKIE_DEV,
    FACILITY_COOKIE_PROD, // 施設コンテキストも共有端末の次ユーザに残さない
    FACILITY_COOKIE_DEV,
  ]) {
    // __Host- cookies require Secure even on the expiration response. A bare
    // delete omits it, so browsers reject the deletion and retain credentials.
    jar.set(name, "", {
      httpOnly: true,
      sameSite: "strict",
      secure: name.startsWith("__Host-"),
      path: "/",
      expires: new Date(0),
      maxAge: 0,
    });
  }
}

/**
 * API へのサーバ側呼び出し。セッションの credential を Bearer + App Check として転送する。
 * PHI はサーバ側からのみ流れ、ブラウザ JS の手を介さない。
 */
export async function sessionApiFetch(
  session: StaffSession,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const { apiBaseUrl } = clientConfig();
  const headers: Record<string, string> = { authorization: `Bearer ${session.idToken}` };
  if (session.appCheckToken) headers["x-firebase-appcheck"] = session.appCheckToken;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${apiBaseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}
