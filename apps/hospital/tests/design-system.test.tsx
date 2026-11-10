import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HxButton } from "../components/design-system/hx-button";
import { DELIVERY_STATUS, HxBadge, HxStatusBadge } from "../components/design-system/hx-status-badge";
import { HxConfirmActionDialog, HxDialog } from "../components/design-system/hx-dialog";
import { HxDataTable, HxTd, HxTh, HxTr } from "../components/design-system/hx-data-table";
import { HxEmptyState, HxErrorPanel, HxLoadingState } from "../components/design-system/hx-feedback";
import { HxField, HxFormSection } from "../components/design-system/hx-field";
import { HxPageHeader } from "../components/design-system/hx-page-header";
import { HxAppShell } from "../components/design-system/hx-app-shell";

function render(element: React.ReactElement) {
  return renderToStaticMarkup(element);
}

test("HxButton: バリアント・サイズ・ローディング/disabled の属性", () => {
  const primary = render(<HxButton>受領を確認する</HxButton>);
  assert.match(primary, /bg-hx-primary/);
  assert.match(primary, /受領を確認する/);
  assert.match(primary, /type="button"/);

  const loading = render(<HxButton loading>保存する</HxButton>);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /disabled/);
  assert.match(loading, /処理中です/);

  const danger = render(<HxButton variant="danger" disabled>職員を停止する</HxButton>);
  assert.match(danger, /bg-hx-danger/);
  assert.match(danger, /disabled/);
});

test("HxStatusBadge: deliveries.status → ラベルとトーンが仕様通りマッピングされる", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DELIVERY_STATUS).map(([k, v]) => [k, v.label])),
    {
      created: "配送処理中",
      delivered: "未受領",
      acknowledged: "受領確認済み",
      failed: "配送失敗",
      revoked: "取下げ",
    },
  );
  // §4.4: 未受領を注意色で煽らない
  assert.equal(DELIVERY_STATUS.delivered.tone, "info");
  const html = render(<HxStatusBadge status="acknowledged" />);
  assert.match(html, /受領確認済み/);
  assert.match(html, /bg-hx-success-bg/);
  const badge = render(<HxBadge tone="warning">要確認</HxBadge>);
  assert.match(badge, /要確認/);
});

test("HxField: label・必須表記・説明・エラーが aria で紐づく", () => {
  const html = render(
    <HxField label="メールアドレス" required description="説明文" error="エラー文">
      <input type="email" />
    </HxField>,
  );
  assert.match(html, /for="[^"]+"/);
  assert.match(html, /id="[^"]+"/);
  assert.match(html, /必須/);
  assert.match(html, /aria-describedby="[^"]+-desc [^"]+-error"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /エラー文/);
});

test("HxFormSection: セクションタイトルと説明", () => {
  const html = render(
    <HxFormSection title="施設情報" description="説明です">
      <p>内容</p>
    </HxFormSection>,
  );
  assert.match(html, /施設情報/);
  assert.match(html, /説明です/);
});

test("HxDialog: role=dialog, aria-modal, Esc 非依存のマークアップ、フッター", () => {
  const html = render(
    <HxDialog open onClose={() => undefined} title="確認" description="説明" footer={<button>閉じる</button>}>
      <p>本文</p>
    </HxDialog>,
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  // 閉じた状態は描画しない
  const closed = render(<HxDialog open={false} onClose={() => undefined} title="確認" />);
  assert.equal(closed, "");
});

test("HxConfirmActionDialog: 対象・具体的な動詞・キャンセルを表示", () => {
  const html = render(
    <HxConfirmActionDialog
      open
      subject="受信問診 Q-1"
      title="受領を確認しますか"
      description="この問診票を受領した記録が残ります。"
      confirmLabel="受領を確認する"
      onConfirm={() => undefined}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /対象：<\/span>受信問診 Q-1/);
  assert.match(html, /受領を確認する/);
  assert.match(html, /キャンセル/);
});

test("HxDataTable: caption・th scope・ソートボタン・行高", () => {
  const html = render(
    <HxDataTable caption="受信問診の一覧" busy>
      <thead>
        <tr>
          <HxTh sort="ascending" onSort={() => undefined}>受信日時</HxTh>
          <HxTh>状態</HxTh>
        </tr>
      </thead>
      <tbody>
        <HxTr>
          <HxTd>11/05 14:28</HxTd>
          <HxTd>未受領</HxTd>
        </HxTr>
      </tbody>
    </HxDataTable>,
  );
  assert.match(html, /<caption[^>]*class="sr-only"/);
  assert.match(html, /scope="col"/);
  assert.match(html, /aria-sort="ascending"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /<button[^>]*>受信日時/);
});

test("HxFeedback: 状態コンポーネントの役割と文言", () => {
  const loading = render(<HxLoadingState label="読み込み中です" />);
  assert.match(loading, /role="status"/);
  assert.match(loading, /読み込み中です/);

  const empty = render(<HxEmptyState title="検索条件に一致しません" description="説明" />);
  assert.match(empty, /検索条件に一致しません/);

  const forbidden = render(<HxErrorPanel kind="forbidden" />);
  assert.match(forbidden, /アクセス権限がありません/);
  assert.match(forbidden, /role="alert"/);

  const session = render(<HxErrorPanel kind="session" onAction={() => undefined} />);
  assert.match(session, /ログインし直す/);
});

test("HxPageHeader: パンくず・タイトル・更新時刻", () => {
  const html = render(
    <HxPageHeader
      breadcrumbs={[{ label: "ホーム", href: "/" }, { label: "受信問診" }]}
      title="受信問診"
      updatedAt="最終更新：14:28"
      actions={<button>更新</button>}
    />,
  );
  assert.match(html, /aria-label="パンくず"/);
  assert.match(html, /<h1[^>]*>受信問診/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /最終更新：14:28/);
});

test("HxAppShell: スキップリンク・施設名・ナビ active・ログアウト", () => {
  const html = render(
    <HxAppShell
      facilityName="さくら合成クリニック"
      staffName="合成 職員"
      onSignOut={() => undefined}
      navItems={[
        { href: "/inbox", label: "受信問診", icon: "inbox", active: true },
        { href: "/staff", label: "職員管理", icon: "users" },
      ]}
    >
      <p>コンテンツ</p>
    </HxAppShell>,
  );
  assert.match(html, /メインコンテンツへ移動/);
  assert.match(html, /id="hx-main-content"/);
  assert.match(html, /さくら合成クリニック/);
  assert.match(html, /合成 職員/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /bg-hx-nav-active/);
  assert.match(html, /ログアウト/);
  // 施設未選択でもヘッダーが消えない
  const noFacility = render(
    <HxAppShell facilityName={null} navItems={[]}>
      <p>x</p>
    </HxAppShell>,
  );
  assert.match(noFacility, /施設未選択/);
});
