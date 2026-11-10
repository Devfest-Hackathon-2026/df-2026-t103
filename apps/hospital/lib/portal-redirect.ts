import { NextResponse } from "next/server";

/** Use an explicit public origin; reverse proxies can expose an internal req.url. */
export function portalRedirect(requestUrl: string, path: "/login" | "/facilities", query = new URLSearchParams()) {
  const configured = process.env.HOSPITAL_PUBLIC_ORIGIN;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("HOSPITAL_PUBLIC_ORIGIN is required for production redirects.");
  }
  const origin = new URL(configured || requestUrl);
  if (configured && (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)) {
    throw new Error("HOSPITAL_PUBLIC_ORIGIN must be an HTTPS origin.");
  }
  const target = new URL(path, origin.origin);
  target.search = query.toString();
  // Do not trust incoming Host or forwarded-host headers for redirect destinations.
  return NextResponse.redirect(target);
}
