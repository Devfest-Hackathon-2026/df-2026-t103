import { randomId } from "./hash.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** クライアント提供 X-Request-Id を検証し、不正なら新規発行する。 */
export function resolveRequestId(header: string | undefined): string {
  if (header && SAFE_REQUEST_ID.test(header)) {
    return header;
  }
  return randomId("req");
}
