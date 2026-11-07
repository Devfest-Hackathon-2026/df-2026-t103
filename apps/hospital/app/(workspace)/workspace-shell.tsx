"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { HxAppShell, type HxNavItem } from "../../components/design-system/hx-app-shell";
import { firebaseClient } from "../../lib/firebase-client";
import { destroySession, establishSession } from "../../lib/staff-session";
import type { StaffMembership } from "../../lib/memberships";

/** Cookie 消去込みでログイン画面へ戻す（再読み込み後のFirebase未認証を含む）。 */
function toLogout(pathname: string) {
  const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Cookie消去はRoute Handler側で行う必要がある
  location.assign(`/api/session/logout${next}`);
}

const MembershipsContext = createContext<StaffMembership[]>([]);
const SelectedFacilityContext = createContext<StaffMembership | null>(null);

export function useMemberships(): StaffMembership[] {
  return useContext(MembershipsContext);
}

/** サーバでメンバーシップ照合済みの選択施設。未選択・無効値は null。 */
export function useSelectedFacility(): StaffMembership | null {
  return useContext(SelectedFacilityContext);
}

/** ID トークン寿命（約60分）に先立つ定期的なセッションCookie更新間隔。 */
const RENEW_INTERVAL_MS = 10 * 60 * 1000;

function SessionKeeper({
  pathname,
  onUserChange,
}: {
  pathname: string;
  onUserChange: (name: string | null) => void;
}) {
  useEffect(() => {
    const client = firebaseClient();
    // Firebase サインイン状態が切れたら（失効・再読み込みでメモリ消失）Cookie も消して
    // H-001 へ戻す。inMemoryPersistence のためブラウザ再読み込みは再ログインになる。
    const unsubscribe = onIdTokenChanged(client.auth, (user) => {
      onUserChange(user?.displayName ?? user?.email ?? null);
      if (!user) toLogout(pathname);
    });
    const renew = () => {
      if (client.auth.currentUser) {
        void establishSession().catch(() => undefined);
      }
    };
    const interval = setInterval(renew, RENEW_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname, onUserChange]);
  return null;
}

export function WorkspaceShell({
  memberships,
  selectedFacility,
  children,
}: {
  memberships: StaffMembership[];
  selectedFacility: StaffMembership | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [staffName, setStaffName] = useState<string | null>(null);

  const navItems: HxNavItem[] = [
    {
      href: "/deliveries",
      label: "受信問診",
      icon: "inbox",
      active: pathname === "/deliveries" || pathname.startsWith("/deliveries/"),
    },
    { href: "/facilities", label: "施設の切替", icon: "building", active: pathname === "/facilities" },
  ];

  async function handleSignOut() {
    await signOut(firebaseClient().auth).catch(() => undefined);
    await destroySession();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 全面遷移でFirebaseのインメモリ状態も確実に破棄する
    location.assign("/login");
  }

  return (
    <MembershipsContext.Provider value={memberships}>
      <SelectedFacilityContext.Provider value={selectedFacility}>
        <SessionKeeper pathname={pathname} onUserChange={setStaffName} />
        <HxAppShell
          facilityName={selectedFacility?.facility?.displayName ?? null}
          facilityHref="/facilities"
          staffName={staffName}
          navItems={navItems}
          onSignOut={handleSignOut}
        >
          {children}
        </HxAppShell>
      </SelectedFacilityContext.Provider>
    </MembershipsContext.Provider>
  );
}
