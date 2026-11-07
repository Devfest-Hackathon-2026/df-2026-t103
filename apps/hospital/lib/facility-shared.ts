import { clientConfig } from "./client-config";

/** 施設コンテキスト Cookie 名（環境で切替）。 */
export const FACILITY_COOKIE_PROD = "__Host-mmr-facility";
export const FACILITY_COOKIE_DEV = "mmr-facility";

/** API の施設ID契約に合わせた検証（サービス側の doc id 文字種を踏襲）。 */
export const FACILITY_ID_PATTERN = /^[\w-]{1,128}$/;

export function facilityCookieName(): string {
  return clientConfig().emulator ? FACILITY_COOKIE_DEV : FACILITY_COOKIE_PROD;
}
