import "server-only";
import { cookies } from "next/headers";
import { clientConfig } from "./client-config";
import { facilityCookieName, FACILITY_COOKIE_DEV, FACILITY_COOKIE_PROD, FACILITY_ID_PATTERN } from "./facility-shared";

export { facilityCookieName };

/**
 * 選択中施設のコンテキスト Cookie（H-002）。
 * 値は facilityId のみ。表示名・認可は毎回 API の facilityMemberships と照合するため、
 * Cookie 値の改ざんは UI の誤表示にしかならず、データアクセス権は与えない。
 */

function facilityCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: !clientConfig().emulator,
    path: "/",
    maxAge: 8 * 60 * 60, // 1業務セッション相当
  };
}

/** Cookie の生値。照合なしで信用しないこと。 */
export async function readFacilityCookie(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(facilityCookieName())?.value;
  return value && FACILITY_ID_PATTERN.test(value) ? value : null;
}

export async function writeFacilityCookie(facilityId: string): Promise<void> {
  const jar = await cookies();
  jar.set(facilityCookieName(), facilityId, facilityCookieOptions());
}

export async function clearFacilityCookie(): Promise<void> {
  const jar = await cookies();
  for (const name of [FACILITY_COOKIE_PROD, FACILITY_COOKIE_DEV]) jar.delete(name);
}
