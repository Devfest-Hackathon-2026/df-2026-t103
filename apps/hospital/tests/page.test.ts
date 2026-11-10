import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";
import OperatorPage from "../app/operator/page";

test("links to the real API screen without displaying fictional deliveries", () => {
  const html = renderToStaticMarkup(createElement(Home));
  assert.match(html, /href="\/operator"/);
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /サンプル患者|合成データ|表示例/);
  assert.doesNotMatch(html, /<form|<button/);
});

test("login form cannot submit credentials via GET before hydration", () => {
  const html = renderToStaticMarkup(createElement(OperatorPage));
  assert.match(html, /<form[^>]*method="post"/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.doesNotMatch(html, /<tbody|SYNTHETIC_PRIVATE_VALUE|サンプル患者/);
});
