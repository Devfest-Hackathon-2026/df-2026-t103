import type { NextRequest } from "next/server";
import {
  assertPortalClient,
  clearSession,
  portalJson,
  sessionApiFetch,
  writeSession,
} from "../../../lib/session";

/**
 * POST /api/session — ログイン後のセッション確立。
 * 受け取った ID トークンを実APIで検証し、有効な場合のみ HttpOnly Cookie へ保存する。
 * 検証を通らないトークンで Cookie は発行しない。
 */
export async function POST(req: NextRequest) {
  const forbidden = assertPortalClient(req);
  if (forbidden) return forbidden;

  let body: { idToken?: unknown; appCheckToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return portalJson({ error: "bad_request" }, { status: 400 });
  }
  // IDトークンはCookie容量の上限より小さいことを要求（ブラウザが超過Cookieを黙って捨てるため）
  if (typeof body.idToken !== "string" || body.idToken.length === 0 || body.idToken.length > 4096) {
    return portalJson({ error: "bad_request" }, { status: 400 });
  }
  const appCheckToken =
    typeof body.appCheckToken === "string" &&
    body.appCheckToken.length > 0 &&
    body.appCheckToken.length <= 4096
      ? body.appCheckToken
      : null;

  const upstream = await sessionApiFetch(
    { idToken: body.idToken, appCheckToken },
    "/me/facility-memberships",
  ).catch(() => null);
  if (!upstream) {
    return portalJson({ error: "service_unavailable" }, { status: 503 });
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return portalJson({ error: "unauthenticated" }, { status: 401 });
  }
  if (!upstream.ok) {
    return portalJson({ error: "upstream_error" }, { status: 502 });
  }

  await writeSession({ idToken: body.idToken, appCheckToken });
  try {
    return portalJson(await upstream.json());
  } catch {
    return portalJson({ error: "upstream_error" }, { status: 502 });
  }
}

/** DELETE /api/session — ログアウト。Cookie を完全に消去する。 */
export async function DELETE(req: NextRequest) {
  const forbidden = assertPortalClient(req);
  if (forbidden) return forbidden;
  await clearSession();
  return portalJson({ ok: true });
}
