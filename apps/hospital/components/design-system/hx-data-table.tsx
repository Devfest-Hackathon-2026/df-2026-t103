import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { HxIcon } from "./hx-icon";

// §17.3: <table>/<thead>/<th scope="col"> 基盤。行44px、hoverは薄い青。
export function HxDataTable({
  caption,
  busy = false,
  children,
  className = "",
}: {
  /** 視覚には出さない表の説明（スクリーンリーダー用） */
  caption: string;
  busy?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-x-auto rounded-md border border-hx-border bg-hx-surface ${className}`}>
      <table className="w-full border-collapse text-hx-body" aria-busy={busy || undefined}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export interface HxThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** ソート可能列はボタン＋方向アイコン＋aria-sort（§17.3）。未適用時は "none"。 */
  sort?: "ascending" | "descending" | "none";
  onSort?: () => void;
}

export function HxTh({ sort, onSort, children, className = "", ...rest }: HxThProps) {
  const base = `border-b border-hx-border bg-hx-surface-subtle px-3 py-2 text-left align-middle text-hx-table-header font-semibold text-hx-text-subtle ${className}`;
  if (sort !== undefined) {
    return (
      <th scope="col" aria-sort={sort} className={base} {...rest}>
        <button
          type="button"
          onClick={onSort}
          className="inline-flex w-full items-center gap-1 font-semibold hover:text-hx-text"
        >
          {children}
          <HxIcon
            name={sort === "ascending" ? "chevron-up" : sort === "descending" ? "chevron-down" : "chevrons"}
            size={14}
            className={sort === "none" ? "opacity-50" : undefined}
          />
        </button>
      </th>
    );
  }
  return (
    <th scope="col" className={base} {...rest}>
      {children}
    </th>
  );
}

export function HxTd({
  numeric = false,
  children,
  className = "",
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={`border-b border-hx-divider px-3 py-2.5 align-middle ${numeric ? "tabular-nums" : ""} ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}

export function HxTr({
  children,
  selected = false,
  className = "",
}: {
  children: ReactNode;
  selected?: boolean;
  className?: string;
}) {
  return (
    <tr
      // §4.3/§17.3: 選択は色だけでなく左境界を併用する
      className={`h-11 ${selected ? "bg-hx-row-selected shadow-[inset_2px_0_0_var(--color-hx-primary)]" : "hover:bg-hx-row-hover"} ${className}`}
    >
      {children}
    </tr>
  );
}
