import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// Only the current, disconnected demo is permitted here. Add exact service
// origins when the authenticated client is implemented; do not use wildcards.
export function securityHeaders(nonce: string, development: boolean) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws://localhost:* ws://127.0.0.1:* http://localhost:9099 http://localhost:8081 http://localhost:9199" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!development ? ["upgrade-insecure-requests"] : []),
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

export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString("base64");
  const headers = securityHeaders(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  // Overwrite untrusted client headers before Next.js extracts the script nonce.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

export const config = {
  // Also protect RSC, prefetch, errors and routes with file-like names.
  matcher: ["/((?!_next/static/).*)"],
};
