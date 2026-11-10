import { HxIcon, type HxIconName } from "./hx-icon";

export type HxStatusTone = "success" | "warning" | "danger" | "info" | "neutral";

// §17.5: バックエンド deliveries.status → 表示ラベル・Tone の対応。
// 「未受領」は注意色で煽らない（§4.4）ため warning ではなく info とする。
export const DELIVERY_STATUS = {
  created: { label: "配送処理中", tone: "info" },
  delivered: { label: "未受領", tone: "info" },
  acknowledged: { label: "受領確認済み", tone: "success" },
  failed: { label: "配送失敗", tone: "danger" },
  revoked: { label: "取下げ", tone: "neutral" },
} as const satisfies Record<string, { label: string; tone: HxStatusTone }>;

export type HxDeliveryStatus = keyof typeof DELIVERY_STATUS;

const TONES: Record<HxStatusTone, { classes: string; icon: HxIconName }> = {
  success: { classes: "bg-hx-success-bg text-hx-success", icon: "check-circle" },
  warning: { classes: "bg-hx-warning-bg text-hx-warning", icon: "alert-triangle" },
  danger: { classes: "bg-hx-danger-bg text-hx-danger", icon: "x-circle" },
  info: { classes: "bg-hx-info-bg text-hx-info", icon: "info" },
  neutral: { classes: "bg-hx-neutral-bg text-hx-neutral", icon: "help-circle" },
};

/** 汎用バッジ。状態色だけに意味を持たせず、必ず文字ラベルとアイコンを併記する（§4.4/§7.3）。 */
export function HxBadge({
  tone,
  children,
  className = "",
}: {
  tone: HxStatusTone;
  children: string;
  className?: string;
}) {
  const { classes, icon } = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-hx-caption font-semibold ${classes} ${className}`}
    >
      <HxIcon name={icon} size={14} />
      {children}
    </span>
  );
}

export function HxStatusBadge({ status }: { status: HxDeliveryStatus }) {
  // 未定義の状態値がAPIから来た場合、成功系へ誤表示しないよう中立の「不明」で示す
  const entry = (DELIVERY_STATUS as Record<string, { label: string; tone: HxStatusTone }>)[status] ?? {
    label: "不明",
    tone: "neutral" as const,
  };
  return <HxBadge tone={entry.tone}>{entry.label}</HxBadge>;
}
