import type { ButtonHTMLAttributes, ReactNode } from "react";

export type HxButtonVariant = "primary" | "secondary" | "danger" | "subtle";
export type HxButtonSize = "md" | "sm";

const VARIANTS: Record<HxButtonVariant, string> = {
  primary:
    "bg-hx-primary text-hx-on-primary hover:bg-hx-primary-hover disabled:hover:bg-hx-primary",
  secondary:
    "border border-hx-border bg-hx-surface text-hx-primary hover:bg-hx-row-hover disabled:hover:bg-hx-surface",
  danger:
    "bg-hx-danger text-hx-on-primary hover:bg-hx-danger-hover disabled:hover:bg-hx-danger",
  subtle: "text-hx-primary hover:bg-hx-row-hover disabled:hover:bg-transparent",
};

// §6.4: 主ボタン高さ36〜40px、二次ボタン32〜36px。min-h で文字拡大時の伸縮を許す。
const SIZES: Record<HxButtonSize, string> = {
  md: "min-h-10 px-4 py-1.5",
  sm: "min-h-8 px-3 py-1",
};

export interface HxButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: HxButtonVariant;
  size?: HxButtonSize;
  loading?: boolean;
  /** true のとき内容幅いっぱいではなく親幅に広げる */
  block?: boolean;
  children: ReactNode;
}

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function HxButton({
  variant = "primary",
  size = "md",
  loading = false,
  block = false,
  disabled,
  type = "button",
  className = "",
  children,
  ...rest
}: HxButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${block ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
      {loading ? <span className="sr-only">処理中です</span> : null}
    </button>
  );
}
