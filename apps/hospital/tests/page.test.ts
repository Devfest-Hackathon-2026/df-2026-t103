import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";

test("identifies demo data and unimplemented operations", () => {
  const html = renderToStaticMarkup(createElement(Home));
  assert.match(html, /デモ専用・実運用不可/);
  assert.match(html, /認証、アクセス制御、問診の受信・閲覧は未実装/);
  assert.match(html, /合成データ/);
  assert.doesNotMatch(html, /<form|<button/);
});
