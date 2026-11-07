import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = { title: "医療機関ポータル | もしもし問診" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonces belong to one request and must never be embedded in static HTML.
  await connection();
  return <html lang="ja"><body>{children}</body></html>;
}
