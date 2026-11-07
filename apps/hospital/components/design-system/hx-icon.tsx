import type { JSX } from "react";

// docs/10_デザインシステム.md §7.3: HX は 16〜20px の Outline アイコン。
// 主要操作は必ず文字ラベルと併用するため、ここでは装飾用途に限定した最小セットを用意する。
const PATHS = {
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
    </>
  ),
  "alert-triangle": (
    <>
      <path d="M12 4 3 19h18L12 4Z" />
      <path d="M12 10v4" />
      <path d="M12 16.8v.2" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.8v.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  "help-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.3a2.5 2.5 0 1 1 3.4 2.3c-.8.4-.9 1-.9 1.7" />
      <path d="M12 16.8v.2" />
    </>
  ),
  chevrons: (
    <>
      <path d="m7 10 5-5 5 5" />
      <path d="m7 14 5 5 5-5" />
    </>
  ),
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
  "chevron-left": <path d="M14.5 6 8.5 12l6 6" />,
  "chevron-right": <path d="m9.5 6 6 6-6 6" />,
  "chevron-up": <path d="m6 14.5 6-6 6 6" />,
  "arrow-left": (
    <>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  building: (
    <>
      <path d="M5 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15" />
      <path d="M15 9h4a1 1 0 0 1 1 1v10" />
      <path d="M3 20h18" />
      <path d="M8 8h2M8 12h2M8 16h2M12 8h.5M12 12h.5M12 16h.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.8 19.5a5.7 5.7 0 0 1 11.4 0" />
      <path d="M15.5 5.7a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.3a5.7 5.7 0 0 1 2.8 5.2" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5 6.5 5h11L20 13.5V19H4v-5.5Z" />
      <path d="M4 13.5h5l1 2h4l1-2h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M4.6 6.5l1.7 1M17.7 16l1.7 1M3.5 12h2M18.5 12h2M4.6 17.5l1.7-1M17.7 8l1.7-1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-1.5 6.5" />
      <path d="M20 5v6h-6" />
    </>
  ),
  "file-text": (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4" />
      <path d="M9 11h6M9 15h6" />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M12 14v2.5" />
    </>
  ),
  mail: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4H7a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h7" />
      <path d="m16.5 8 4 4-4 4" />
      <path d="M9.5 12h11" />
    </>
  ),
  "external-link": (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5" />
    </>
  ),
} as const;

export type HxIconName = keyof typeof PATHS;

export function HxIcon({
  name,
  size = 16,
  className,
  title,
}: {
  name: HxIconName;
  size?: number;
  className?: string;
  /** 指定時は装飾ではなく意味のある画像として title を読み上げ対象にする */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      className={className}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name] as JSX.Element}
    </svg>
  );
}
