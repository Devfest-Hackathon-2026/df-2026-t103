/** フォーカス可能要素の共通セレクタ（ダイアログ・ドロワーのフォーカス制御で共用）。 */
export const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Tab/Shift+Tab をコンテナ内に封じる。パネル外にフォーカスがある場合は先頭（Shift は末尾）へ戻す。
 * モーダル下の背景へ Tab が抜けないようにするための共通処理。
 */
export function containTabKey(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const items = focusableIn(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
