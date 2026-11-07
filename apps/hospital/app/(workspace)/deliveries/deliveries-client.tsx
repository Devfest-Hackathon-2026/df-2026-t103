"use client";

import Link from "next/link";
import { HxEmptyState } from "../../../components/design-system/hx-feedback";
import { HxPageHeader } from "../../../components/design-system/hx-page-header";
import { useSelectedFacility } from "../workspace-shell";

export function DeliveriesClient() {
  const selected = useSelectedFacility();

  if (!selected) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 pt-8">
        <HxEmptyState
          icon="building"
          title="施設が選択されていません"
          description="受信問診を表示するには、まず業務を行う施設を選択してください。"
        />
        <Link
          href="/facilities"
          className="inline-flex h-9 items-center rounded-sm bg-hx-primary px-4 text-hx-body font-semibold text-hx-on-primary"
        >
          施設を選択する
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <HxPageHeader title="受信問診" />
      <HxEmptyState
        icon="inbox"
        title="受信問診一覧は現在実装中です"
        description={`${selected.facility?.displayName ?? "選択中の施設"}の問診をここに表示します。`}
      />
    </div>
  );
}
