import Link from "next/link";
import { HxEmptyState } from "../../../../components/design-system/hx-feedback";
import { HxPageHeader } from "../../../../components/design-system/hx-page-header";

/**
 * H-004 問診詳細の受け皿。一覧からの遷移先が404にならないよう
 * プレースホルダのみ用意し、確定票・薬剤・受領確認の実装は #85 で行う。
 */
export default async function DeliveryDetailPage({
  params,
}: {
  params: Promise<{ deliveryId: string }>;
}) {
  const { deliveryId } = await params;
  return (
    <div className="space-y-4">
      <HxPageHeader title="問診詳細" />
      <HxEmptyState
        icon="file-text"
        title="問診詳細は現在実装中です"
        description={`対象の問診（${deliveryId}）の確定票・薬剤情報・受領確認は後続リリースで提供されます。`}
      />
      <Link
        href="/deliveries"
        className="inline-flex h-9 items-center rounded-sm border border-hx-border bg-hx-surface px-4 text-hx-body font-semibold text-hx-text hover:bg-hx-surface-subtle"
      >
        一覧へ戻る
      </Link>
    </div>
  );
}
