import { NextRequest, NextResponse } from "next/server";
import { clientConfig } from "./client-config";

/** CSRF 用の必須カスタムヘッダー。ブラウザの単純フォームからは送れない。 */
export const PORTAL_CLIENT_HEADER = "x-hx-client";
const PORTAL_CLIENT_VALUE = "portal";

/** Proxy が付与し RSC レイアウトが読む内部パス名ヘッダー（next 復元用）。 */
export const PATHNAME_HEADER = "x-hx-pathname";

export const SESSION_COOKIE_PROD = "__Host-mmr-session";
export const SESSION_COOKIE_DEV = "mmr-session";
export const APPCHECK_COOKIE_PROD = "__Host-mmr-appcheck";
export const APPCHECK_COOKIE_DEV = "mmr-appcheck";

export function sessionSecure(): boolean {
  // Emulator（HTTP localhost）では Secure Cookie を使わない
  return !clientConfig().emulator;
}

export function sessionCookieName(): string {
  return sessionSecure() ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

export function appCheckCookieName(): string {
  return sessionSecure() ? APPCHECK_COOKIE_PROD : APPCHECK_COOKIE_DEV;
}

/**
 * CSRF 対策: SameSite=Strict の Cookie に加え、(1) 必須カスタムヘッダー、
 * (2) Origin/Sec-Fetch-Site の同一オリジン確認、を行う。
 * 問題なければ null、拒否時は 403 レスポンスを返す。
 */
export function assertPortalClient(req: NextRequest): NextResponse | null {
  if (req.headers.get(PORTAL_CLIENT_HEADER) !== PORTAL_CLIENT_VALUE) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (originHost !== req.headers.get("host")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  return null;
}

export function portalJson(data: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(data, { status: init?.status ?? 200 });
  res.headers.set("cache-control", "no-store");
  return res;
}
