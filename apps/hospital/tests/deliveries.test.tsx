import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveriesClient } from "../app/(workspace)/deliveries/deliveries-client";
import DeliveriesPage from "../app/(workspace)/deliveries/page";
import DeliveryDetailPage from "../app/(workspace)/deliveries/[deliveryId]/page";

function render(element: React.ReactElement) {
  return renderToStaticMarkup(element);
}

test("H-003: 施設未選択では一覧ではなく施設選択ガイドを表示する", () => {
  const html = render(<DeliveriesClient />);
  assert.match(html, /施設が選択されていません/);
  assert.match(html, /href="\/facilities"/);
  assert.doesNotMatch(html, /受信日時/);
});

test("H-003: deliveries ページはクライアントコンポーネントを描画する", () => {
  const html = render(<DeliveriesPage />);
  // 施設コンテキストなしの SSR ではガイド表示になる
  assert.match(html, /施設が選択されていません/);
});

test("H-003: 詳細ページは #85 実装前のプレースホルダと一覧復帰導線を持つ", async () => {
  const html = render(
    await DeliveryDetailPage({ params: Promise.resolve({ deliveryId: "dlv_test" }) }),
  );
  assert.match(html, /問診詳細は現在実装中です/);
  assert.match(html, /href="\/deliveries"/);
});
