import { DeliveryDetailClient } from "./delivery-detail-client";

/**
 * H-004 問診詳細（確定票・患者情報・薬剤・既往歴・受領確認）。
 * 閲覧ごとに API 側で DELIVERY_VIEWED 監査が記録される。
 */
export default async function DeliveryDetailPage({
  params,
}: {
  params: Promise<{ deliveryId: string }>;
}) {
  const { deliveryId } = await params;
  // 別票へのクライアント側遷移で前患者のPHIが残らないよう key で確実に再マウントする
  return <DeliveryDetailClient key={deliveryId} deliveryId={deliveryId} />;
}
