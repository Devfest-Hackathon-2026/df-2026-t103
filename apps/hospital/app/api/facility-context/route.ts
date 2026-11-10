import type { NextRequest } from "next/server";
import {
  assertPortalClient,
  portalJson,
  readSession,
  sessionApiFetch,
} from "../../../lib/session";
import { clearFacilityCookie, writeFacilityCookie } from "../../../lib/facility-context";
import { FACILITY_ID_PATTERN } from "../../../lib/facility-shared";
import type { MembershipsResponse } from "../../../lib/memberships";

/**
 * POST /api/facility-context — 施設選択（H-002）。
 * facilityId が本人のアクティブなメンバーシップに含まれることを実APIで確認してから
 * コンテキスト Cookie を書き込む。クライアント提示の ID を鵜呑みにしない。
 */
export async function POST(req: NextRequest) {
  const forbidden = assertPortalClient(req);
  if (forbidden) return forbidden;

  const session = await readSession();
  if (!session) return portalJson({ error: "unauthenticated" }, { status: 401 });

  let body: { facilityId?: unknown };
  try {
    body = await req.json();
  } catch {
    return portalJson({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.facilityId !== "string" || !FACILITY_ID_PATTERN.test(body.facilityId)) {
    return portalJson({ error: "bad_request" }, { status: 400 });
  }

  const upstream = await sessionApiFetch(session, "/me/facility-memberships").catch(
    () => null,
  );
  if (!upstream) return portalJson({ error: "service_unavailable" }, { status: 503 });
  if (upstream.status === 401 || upstream.status === 403) {
    return portalJson({ error: "unauthenticated" }, { status: 401 });
  }
  if (!upstream.ok) return portalJson({ error: "upstream_error" }, { status: 502 });

  let memberships: MembershipsResponse;
  try {
    const data: unknown = await upstream.json();
    if (!data || typeof data !== "object" || !Array.isArray((data as MembershipsResponse).items)) {
      throw new Error("unexpected shape");
    }
    memberships = data as MembershipsResponse;
  } catch {
    return portalJson({ error: "upstream_error" }, { status: 502 });
  }
  const allowed = memberships.items.some((m) => m.facilityId === body.facilityId);
  if (!allowed) {
    // 権限のない施設IDでも詳細は返さない
    return portalJson({ error: "forbidden" }, { status: 403 });
  }

  await writeFacilityCookie(body.facilityId);
  return portalJson({ ok: true });
}

/** DELETE /api/facility-context — 施設選択の解除（切替前のリセット）。 */
export async function DELETE(req: NextRequest) {
  const forbidden = assertPortalClient(req);
  if (forbidden) return forbidden;
  await clearFacilityCookie();
  return portalJson({ ok: true });
}
