import type { ReactNode } from "react";
import { HxIcon, type HxIconName } from "./hx-icon";
import { HxButton } from "./hx-button";

/** §8.3: スピナーだけでなく説明テキストを併記し、読み上げは一度だけ。 */
export function HxLoadingState({
  label = "読み込み中です",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" className={`flex items-center gap-3 text-hx-text-subtle ${className}`}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
    </div>
  );
}

export function HxEmptyState({
  icon = "inbox",
  title,
  description,
  action,
  className = "",
}: {
  icon?: HxIconName;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-md border border-dashed border-hx-border bg-hx-surface px-6 py-10 text-center ${className}`}
    >
      <HxIcon name={icon} size={28} className="text-hx-text-subtle" />
      <p className="text-hx-body font-semibold">{title}</p>
      {description ? <p className="text-hx-body text-hx-text-subtle">{description}</p> : null}
      {action}
    </div>
  );
}

export type HxErrorKind = "error" | "forbidden" | "session" | "notFound" | "offline";

const ERROR_DEFAULTS: Record<
  HxErrorKind,
  { title: string; description: string; icon: HxIconName; actionLabel?: string }
> = {
  error: {
    title: "読み込めませんでした",
    description: "通信状態を確認して、もう一度お試しください。",
    icon: "alert-triangle",
    actionLabel: "再試行",
  },
  forbidden: {
    title: "アクセス権限がありません",
    description: "この操作を行う権限がありません。所属施設と役割を確認してください。",
    icon: "lock",
  },
  session: {
    title: "セッションの有効期限が切れました",
    description: "安全のため再度ログインしてください。",
    icon: "clock",
    actionLabel: "ログインし直す",
  },
  notFound: {
    title: "対象が見つかりません",
    description: "指定された情報は存在しないか、表示する権限がありません。",
    icon: "search",
    actionLabel: "一覧へ戻る",
  },
  offline: {
    title: "通信できません",
    description: "ネットワーク接続を確認して、もう一度お試しください。",
    icon: "alert-triangle",
    actionLabel: "再試行",
  },
};

/** §17.15: ページ全体を破壊せず、参照用の安全な情報だけを示す。生のエラーJSONは表示しない。 */
export function HxErrorPanel({
  kind = "error",
  title,
  description,
  actionLabel,
  onAction,
  referenceId,
  className = "",
}: {
  kind?: HxErrorKind;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** 無害な参照ID（PHI・内部IDを含めない） */
  referenceId?: string;
  className?: string;
}) {
  const defaults = ERROR_DEFAULTS[kind];
  const resolvedAction = actionLabel ?? defaults.actionLabel;
  return (
    <div
      role="alert"
      className={`flex flex-col items-start gap-3 rounded-md border border-hx-border bg-hx-surface px-6 py-8 ${className}`}
    >
      <div className="flex items-center gap-2 text-hx-danger">
        <HxIcon name={defaults.icon} size={20} />
        <p className="text-hx-body font-semibold">{title ?? defaults.title}</p>
      </div>
      <p className="text-hx-body text-hx-text-subtle">{description ?? defaults.description}</p>
      {referenceId ? (
        <p className="text-hx-caption text-hx-text-subtle">参照ID: {referenceId}</p>
      ) : null}
      {resolvedAction && onAction ? (
        <HxButton variant="secondary" size="sm" onClick={onAction}>
          {resolvedAction}
        </HxButton>
      ) : null}
    </div>
  );
}
