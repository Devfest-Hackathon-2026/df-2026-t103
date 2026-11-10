import Link from "next/link";
import type { ReactNode } from "react";

/** ログイン・ランディング等の未認証ページでも共通の56pxヘッダー。認証後は HxAppShell のヘッダーに連続させる。 */
export function PortalHeader({ children }: { children?: ReactNode }) {
  return (
    <>
      <a
        href="#hx-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded-sm focus:bg-hx-primary focus:px-4 focus:py-2 focus:text-hx-on-primary"
      >
        メインコンテンツへ移動
      </a>
      <header className="flex h-14 items-center gap-3 border-b border-hx-border bg-hx-surface px-4 md:px-6">
        <Link href="/" className="text-hx-body font-bold text-hx-primary">
          もしもし問診
        </Link>
        <span aria-hidden="true" className="h-5 w-px bg-hx-border" />
        <span className="text-hx-body text-hx-text-subtle">医療機関ポータル</span>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </header>
    </>
  );
}
