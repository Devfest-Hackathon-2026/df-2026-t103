import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffClient } from "../app/(workspace)/staff/staff-client";
import StaffPage from "../app/(workspace)/staff/page";

function render(element: React.ReactElement) {
  return renderToStaticMarkup(element);
}

test("H-005: 施設未選択では職員管理ではなく施設選択ガイドを表示する", () => {
  const html = render(<StaffClient />);
  assert.match(html, /施設が選択されていません/);
  assert.match(html, /href="\/facilities"/);
  assert.doesNotMatch(html, /職員を招待する/);
});

test("H-005: staff ページはクライアントコンポーネントを描画する", () => {
  const html = render(<StaffPage />);
  assert.match(html, /施設が選択されていません/);
});
