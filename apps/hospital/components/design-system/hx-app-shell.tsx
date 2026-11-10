"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { HxIcon, type HxIconName } from "./hx-icon";
import { containTabKey, focusableIn } from "../../lib/a11y";

export interface HxNavItem {
  href: string;
  label: string;
  icon: HxIconName;
  /** サーバ権限で出し分け済みの項目だけを渡す（§17.1） */
  active?: boolean;
}

export interface HxAppShellProps {
  /** 業務コンテキストの証拠としてヘッダーに常時表示（§17.1）。未選択時は null。 */
  facilityName: string | null;
  /** 施設バッジの押下先（H-002 の施設切替）。未指定なら非リンク表示。 */
  facilityHref?: string;
  staffName?: string | null;
  navItems: HxNavItem[];
  onSignOut?: () => void;
  /** 開発カタログなど、画面全体ではなく枠内で表示する場合 */
  framed?: boolean;
  children: ReactNode;
}

function NavLink({ item, collapsed, onNavigate }: { item: HxNavItem; collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={item.active ? "page" : undefined}
        aria-label={collapsed ? item.label : undefined}
        title={collapsed ? item.label : undefined}
        className={`relative flex min-h-11 items-center gap-3 rounded-sm text-hx-body transition-colors duration-150 ${
          collapsed ? "justify-center" : "px-4"
        } ${
          item.active
            ? "bg-hx-nav-active font-semibold text-hx-primary"
            : "text-hx-text hover:bg-hx-row-hover"
        }`}
      >
        {item.active ? (
          <span aria-hidden="true" className="absolute left-0 top-1.5 h-8 w-1 rounded-full bg-hx-primary" />
        ) : null}
        <HxIcon name={item.icon} size={20} className="shrink-0" />
        <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
      </Link>
    </li>
  );
}

function FacilityBadge({ name, href }: { name: string | null; href?: string }) {
  const body = (
    <>
      <HxIcon name="building" size={16} className="shrink-0" />
      <span className="truncate">{name ?? "施設未選択"}</span>
    </>
  );
  const cls = "inline-flex min-w-0 items-center gap-1.5 rounded-sm bg-hx-surface-subtle px-2.5 py-1 text-hx-label font-semibold";
  if (href) {
    return (
      <Link
        href={href}
        className={`${cls} hover:bg-hx-row-hover`}
        aria-label={`${name ?? "施設未選択"}、施設を切り替える`}
        title="施設を切り替える"
      >
        {body}
      </Link>
    );
  }
  return <span className={cls}>{body}</span>;
}

// §6.3: <1024px はドロワー、1024–1199px は72pxアイコンレール、1200–1439px は220px、≥1440px は240px。
// ≥1200px では利用者の折りたたみ操作で 220/240px サイドバーと72pxレールを切り替えられる。
const NAV_COLLAPSED_KEY = "hx-nav-collapsed";
const NAV_COLLAPSED_EVENT = "hx-nav-collapsed-change";
// localStorage が使えない環境（保存拒否）でも切替を有効にするためのメモリ保持
let navCollapsedMemory = false;

function readNavCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(NAV_COLLAPSED_KEY);
    return stored === null ? navCollapsedMemory : stored === "1";
  } catch {
    return navCollapsedMemory;
  }
}

function subscribeNavCollapsed(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(NAV_COLLAPSED_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(NAV_COLLAPSED_EVENT, onStoreChange);
  };
}

export function HxAppShell({
  facilityName,
  facilityHref,
  staffName,
  navItems,
  onSignOut,
  framed = false,
  children,
}: HxAppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // SSR/ハイドレーション時は常に展開状態で描画し、マウント後に保存値へ同期される
  const navCollapsed = useSyncExternalStore(subscribeNavCollapsed, readNavCollapsed, () => false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  function toggleNavCollapsed() {
    navCollapsedMemory = !readNavCollapsed();
    try {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsedMemory ? "1" : "0");
    } catch {
      // 保存に失敗してもメモリ上の切替だけは有効にする
    }
    window.dispatchEvent(new Event(NAV_COLLAPSED_EVENT));
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    focusableIn(drawer ?? document.body)[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // lg 以上へリサイズしたらドロワーは閉じる（常時レールに切り替わるため）
    const media = window.matchMedia("(min-width: 1024px)");
    const onMediaChange = () => {
      if (media.matches) setDrawerOpen(false);
    };
    media.addEventListener("change", onMediaChange);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setDrawerOpen(false);
        return;
      }
      if (drawer) containTabKey(drawer, event);
    }
    document.addEventListener("keydown", onKeyDown);
    const menuButton = menuButtonRef.current;
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onMediaChange);
      document.body.style.overflow = previousOverflow;
      menuButton?.focus();
    };
  }, [drawerOpen]);

  const pos = framed ? "absolute" : "fixed";

  return (
    <div className={framed ? "relative h-full overflow-hidden" : "min-h-screen bg-hx-canvas"}>
      {/* not-sr-only より後に absolute を指定しないとスキップリンクが不可視のままになるため、この並びを維持する */}
      <a
        href="#hx-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded-sm focus:bg-hx-primary focus:px-4 focus:py-2 focus:text-hx-on-primary"
      >
        メインコンテンツへ移動
      </a>

      {/* 上部ヘッダー 56px（§16.3）。施設名は業務コンテキストの証拠として常時表示。 */}
      <header
        inert={drawerOpen}
        className={`${pos} inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-hx-border bg-hx-surface px-4 md:px-6`}
      >
        <button
          ref={menuButtonRef}
          type="button"
          className="inline-flex size-10 items-center justify-center rounded-sm text-hx-text hover:bg-hx-row-hover lg:hidden"
          aria-expanded={drawerOpen}
          aria-controls="hx-mobile-nav"
          aria-label={drawerOpen ? "ナビゲーションを閉じる" : "ナビゲーションを開く"}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <HxIcon name="menu" size={20} />
        </button>
        <Link href="/" className="shrink-0 text-hx-body font-bold text-hx-primary">
          もしもし問診
        </Link>
        <span aria-hidden="true" className="hidden h-5 w-px bg-hx-border sm:block" />
        <FacilityBadge name={facilityName} href={facilityHref} />
        <div className="ml-auto flex items-center gap-3">
          {staffName ? (
            <span className="hidden items-center gap-1.5 text-hx-body text-hx-text-subtle sm:inline-flex">
              <HxIcon name="user" size={16} />
              <span className="max-w-40 truncate">{staffName}</span>
            </span>
          ) : null}
          {onSignOut ? (
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-hx-body font-semibold text-hx-text-subtle hover:bg-hx-row-hover hover:text-hx-text"
            >
              <HxIcon name="logout" size={16} />
              ログアウト
            </button>
          ) : null}
        </div>
      </header>

      {/* 1024–1199px および ≥1200px の折りたたみ時: 72px アイコンレール */}
      <nav
        aria-label="主要ナビゲーション"
        inert={drawerOpen}
        className={`${pos} bottom-0 left-0 top-14 z-30 hidden w-18 flex-col border-r border-hx-border bg-hx-surface lg:flex ${navCollapsed ? "" : "min-[1200px]:hidden"}`}
      >
        <ul className="flex-1 space-y-1 overflow-y-auto p-2">
          {navItems.map((item) => (
            <NavLink key={item.href} item={item} collapsed={true} />
          ))}
        </ul>
        {/* 1024–1199px は仕様上レール固定のため、展開ボタンは ≥1200px のみ出す */}
        <div className="hidden border-t border-hx-border p-2 min-[1200px]:block">
          <button
            type="button"
            onClick={toggleNavCollapsed}
            aria-expanded={!navCollapsed}
            aria-controls="hx-nav-sidebar"
            aria-label="ナビゲーションを展開する"
            title="ナビゲーションを展開する"
            className="flex min-h-11 w-full items-center justify-center rounded-sm text-hx-text transition-colors duration-150 hover:bg-hx-row-hover"
          >
            <HxIcon name="chevron-right" size={20} />
          </button>
        </div>
      </nav>
      {/* ≥1200px: ラベル付きサイドバー（1200–1439は220px、1440以上は240px） */}
      <nav
        id="hx-nav-sidebar"
        aria-label="主要ナビゲーション"
        inert={drawerOpen}
        className={`${pos} bottom-0 left-0 top-14 z-30 w-55 flex-col border-r border-hx-border bg-hx-surface min-[1440px]:w-60 ${navCollapsed ? "hidden" : "hidden min-[1200px]:flex"}`}
      >
        <ul className="flex-1 space-y-1 overflow-y-auto p-3">
          {navItems.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </ul>
        <div className="border-t border-hx-border p-3">
          <button
            type="button"
            onClick={toggleNavCollapsed}
            aria-expanded={!navCollapsed}
            aria-controls="hx-nav-sidebar"
            className="flex min-h-11 w-full items-center gap-3 rounded-sm px-4 text-hx-body text-hx-text transition-colors duration-150 hover:bg-hx-row-hover"
          >
            <HxIcon name="chevron-left" size={20} className="shrink-0" />
            <span className="truncate">ナビゲーションを折りたたむ</span>
          </button>
        </div>
      </nav>

      {/* <1024px: ドロワーナビ */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-hx-text/40"
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />
          <nav
            ref={drawerRef}
            id="hx-mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label="主要ナビゲーション"
            className="absolute bottom-0 left-0 top-0 w-64 bg-hx-surface shadow-xl"
          >
            <div className="flex h-14 items-center justify-between border-b border-hx-divider px-4">
              <span className="text-hx-body font-bold text-hx-primary">もしもし問診</span>
              <button
                type="button"
                className="inline-flex size-10 items-center justify-center rounded-sm hover:bg-hx-row-hover"
                aria-label="ナビゲーションを閉じる"
                onClick={() => setDrawerOpen(false)}
              >
                <HxIcon name="x" size={20} />
              </button>
            </div>
            <ul className="space-y-1 p-3">
              {navItems.map((item) => (
                <NavLink key={item.href} item={item} onNavigate={() => setDrawerOpen(false)} />
              ))}
            </ul>
          </nav>
        </div>
      ) : null}

      <main
        id="hx-main-content"
        inert={drawerOpen}
        tabIndex={-1}
        className={`pt-14 lg:pl-18 ${navCollapsed ? "" : "min-[1200px]:pl-55 min-[1440px]:pl-60"} ${framed ? "h-full overflow-auto" : "min-h-screen"}`}
      >
        <div className="p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
