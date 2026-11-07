import Link from "next/link";
import type { ReactNode } from "react";
import { HxIcon } from "./hx-icon";

export interface HxBreadcrumb {
  label: string;
  href?: string;
}

// §17.2: パンくず → 主題 → 説明/最終更新 → 主要アクション（右揃え）。
export function HxPageHeader({
  breadcrumbs,
  title,
  description,
  updatedAt,
  actions,
}: {
  breadcrumbs?: HxBreadcrumb[];
  title: string;
  description?: string;
  /** 取得日時など「いつのデータか」を示すラベル */
  updatedAt?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 space-y-2">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="パンくず">
          <ol className="flex flex-wrap items-center gap-1 text-hx-caption text-hx-text-subtle">
            {breadcrumbs.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex items-center gap-1">
                {index > 0 ? <HxIcon name="chevron-right" size={12} aria-hidden="true" /> : null}
                {item.href ? (
                  <Link href={item.href} className="underline-offset-2 hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span aria-current={index === breadcrumbs.length - 1 ? "page" : undefined}>
                    {item.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-hx-page-title font-bold">{title}</h1>
          {description ? <p className="text-hx-body text-hx-text-subtle">{description}</p> : null}
          {updatedAt ? <p className="text-hx-caption text-hx-text-subtle">{updatedAt}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
