import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "医療機関ポータル | もしもし問診" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
