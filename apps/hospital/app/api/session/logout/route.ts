import { NextResponse, type NextRequest } from "next/server";
import { clearSession } from "../../../../lib/session";

/**
 * GET /api/session/logout — Cookie を消して /login へ戻すナビゲーション用。
 * トップレベル遷移では必須ヘッダーを付けられないため、Sec-Fetch-Site のみで
 * 同一オリジンを確認する（外部サイトからの強制ログアウトCSRFを防ぐ）。
 */
export async function GET(req: NextRequest) {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await clearSession();
  const next = req.nextUrl.searchParams.get("next") ?? "";
  const loginUrl = new URL("/login", req.url);
  if (next.startsWith("/") && !next.startsWith("//")) {
    loginUrl.searchParams.set("next", next);
  }
  const res = NextResponse.redirect(loginUrl);
  res.headers.set("cache-control", "no-store");
  return res;
}
