import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** uid / idempotency-key 等を衝突しない形で連結する。 */
export function hmacParts(secret: string, ...parts: string[]): string {
  return hmacSha256Hex(secret, parts.map((p) => `${p.length}:${p}`).join("|"));
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(10).toString("base64url");
  return `${prefix}_${time}${rand}`;
}

/** JSON のキー順に依存しない正規化文字列（requestHash 用）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}
