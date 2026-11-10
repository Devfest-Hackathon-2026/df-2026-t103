import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsClient } from "../app/(workspace)/settings/settings-client";
import SettingsPage from "../app/(workspace)/settings/page";

function render(element: React.ReactElement) {
  return renderToStaticMarkup(element);
}

test("H-006: 施設未選択では施設設定ではなく施設選択ガイドを表示する", () => {
  const html = render(<SettingsClient />);
  assert.match(html, /施設が選択されていません/);
  assert.match(html, /href="\/facilities"/);
  assert.doesNotMatch(html, /受付を停止する/);
});

test("H-006: settings ページはクライアントコンポーネントを描画する", () => {
  const html = render(<SettingsPage />);
  assert.match(html, /施設が選択されていません/);
});
