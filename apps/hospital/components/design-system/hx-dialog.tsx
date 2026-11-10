"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { HxButton } from "./hx-button";
import { containTabKey, focusableIn } from "../../lib/a11y";

export interface HxDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 補足説明。aria-describedby に紐づく */
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** パネルの最大幅 */
  widthClass?: string;
}

// §17.10: Esc、フォーカストラップ、閉じたときのフォーカス復帰、背景スクロール制御に対応。
export function HxDialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  widthClass = "max-w-lg",
}: HxDialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // 呼び出し側のインライン関数で effect が再実行されフォーカスが飛ばないよう参照だけ最新化する
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      focusableIn(panel ?? document.body)[0] ??
      panel;
    target?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (panel) containTabKey(panel, event);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-hx-text/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-y-auto ${widthClass} rounded-lg bg-hx-surface shadow-xl`}
      >
        <div className="space-y-2 px-6 pt-5">
          <h2 id={titleId} className="text-hx-section-title font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="text-hx-body text-hx-text-subtle">
              {description}
            </p>
          ) : null}
        </div>
        {children ? <div className="px-6 py-4 text-hx-body">{children}</div> : null}
        {footer ? (
          <div className="mt-auto flex justify-end gap-3 border-t border-hx-divider px-6 py-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export interface HxConfirmActionDialogProps {
  open: boolean;
  /** 操作対象（施設名・氏名・問診IDなど必要最小限、§17.9） */
  subject: string;
  title: string;
  description: string;
  /** 確認ボタンは「受領を確認する」「職員を停止する」など動詞を具体化 */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function HxConfirmActionDialog({
  open,
  subject,
  title,
  description,
  confirmLabel,
  cancelLabel = "キャンセル",
  tone = "primary",
  busy = false,
  onConfirm,
  onClose,
}: HxConfirmActionDialogProps) {
  return (
    <HxDialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={description}
      footer={
        <>
          <HxButton variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            {cancelLabel}
          </HxButton>
          <HxButton variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </HxButton>
        </>
      }
    >
      <p className="rounded-sm bg-hx-surface-subtle px-3 py-2 text-hx-body">
        <span className="font-semibold">対象：</span>
        {subject}
      </p>
    </HxDialog>
  );
}
