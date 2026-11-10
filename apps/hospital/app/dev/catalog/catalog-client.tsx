"use client";

import { useState } from "react";
import { HxAppShell } from "../../../components/design-system/hx-app-shell";
import { HxBadge, HxStatusBadge, DELIVERY_STATUS } from "../../../components/design-system/hx-status-badge";
import { HxButton } from "../../../components/design-system/hx-button";
import { HxConfirmActionDialog, HxDialog } from "../../../components/design-system/hx-dialog";
import { HxDataTable, HxTd, HxTh, HxTr } from "../../../components/design-system/hx-data-table";
import { HxEmptyState, HxErrorPanel, HxLoadingState } from "../../../components/design-system/hx-feedback";
import { HxField, HxFormSection, hxInputClass } from "../../../components/design-system/hx-field";
import { HxPageHeader } from "../../../components/design-system/hx-page-header";
import { HxSkeleton, HxSkeletonRows } from "../../../components/design-system/hx-skeleton";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-hx-border bg-hx-surface p-5">
      <h2 className="text-hx-section-title font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function CatalogClient() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sortAsc, setSortAsc] = useState(false);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-hx-page-title font-bold">HX デザインシステム カタログ（開発用）</h1>
        <p className="text-hx-body text-hx-text-subtle">
          docs/10_デザインシステム.md に基づく共通コンポーネントの動作確認ページです。本番環境では表示されません。
        </p>
      </div>

      <Section title="HxButton">
        <div className="flex flex-wrap items-center gap-3">
          <HxButton>受領を確認する</HxButton>
          <HxButton variant="secondary">一覧へ戻る</HxButton>
          <HxButton variant="danger">職員を停止する</HxButton>
          <HxButton variant="subtle">条件をすべて解除</HxButton>
          <HxButton loading>受領を確認する</HxButton>
          <HxButton disabled>受領を確認する</HxButton>
          <HxButton size="sm">保存する</HxButton>
        </div>
      </Section>

      <Section title="HxStatusBadge / HxBadge">
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(DELIVERY_STATUS) as (keyof typeof DELIVERY_STATUS)[]).map((status) => (
            <HxStatusBadge key={status} status={status} />
          ))}
          <HxBadge tone="warning">要確認</HxBadge>
          <HxBadge tone="neutral">任意</HxBadge>
        </div>
      </Section>

      <Section title="HxField / HxFormSection">
        <HxFormSection title="フォーム例" description="説明文とエラーは aria-describedby でフィールドに紐づきます。">
          <div className="grid max-w-md gap-4">
            <HxField label="メールアドレス" required description="職員宛ての招待に使用します。">
              <input type="email" className={hxInputClass} placeholder="staff@example.test" autoComplete="off" />
            </HxField>
            <HxField label="表示名" optional>
              <input className={hxInputClass} />
            </HxField>
            <HxField label="施設名" error="正式名称を確認してください。">
              <input className={hxInputClass} defaultValue="架空クリニック" readOnly />
            </HxField>
          </div>
        </HxFormSection>
      </Section>

      <Section title="HxPageHeader">
        <HxPageHeader
          breadcrumbs={[{ label: "ホーム", href: "/" }, { label: "受信問診" }]}
          title="受信問診"
          description="自院に配送された問診票の一覧です。"
          updatedAt="最終更新：2026-11-05 14:28"
          actions={<HxButton variant="secondary" size="sm">更新</HxButton>}
        />
      </Section>

      <Section title="HxDataTable">
        <HxDataTable caption="受信問診の一覧（合成サンプル）">
          <thead>
            <tr>
              <HxTh sort={sortAsc ? "ascending" : "descending"} onSort={() => setSortAsc((v) => !v)}>受信日時</HxTh>
              <HxTh>患者表示名</HxTh>
              <HxTh>問診ID</HxTh>
              <HxTh>状態</HxTh>
              <HxTh>操作</HxTh>
            </tr>
          </thead>
          <tbody>
            <HxTr>
              <HxTd>11/05 14:28</HxTd>
              <HxTd>合成 患者A</HxTd>
              <HxTd>Q-20261105-0001</HxTd>
              <HxTd><HxStatusBadge status="delivered" /></HxTd>
              <HxTd><button type="button" className="font-semibold text-hx-primary underline">詳細を見る</button></HxTd>
            </HxTr>
            <HxTr>
              <HxTd>11/05 13:02</HxTd>
              <HxTd>合成 患者B</HxTd>
              <HxTd>Q-20261105-0002</HxTd>
              <HxTd><HxStatusBadge status="acknowledged" /></HxTd>
              <HxTd><button type="button" className="font-semibold text-hx-primary underline">詳細を見る</button></HxTd>
            </HxTr>
            <HxSkeletonRows rows={2} columns={5} />
          </tbody>
        </HxDataTable>
      </Section>

      <Section title="共通状態（HxLoadingState / HxEmptyState / HxErrorPanel）">
        <HxLoadingState label="受信問診を読み込み中です" />
        <div className="grid gap-4 md:grid-cols-2">
          <HxEmptyState title="本日の新着はありません" description="新しい問診票が届くとここに表示されます。" />
          <HxEmptyState title="検索条件に一致しません" description="条件を変更して再度お試しください。" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <HxErrorPanel kind="error" onAction={() => undefined} referenceId="req_demo123" />
          <HxErrorPanel kind="forbidden" />
          <HxErrorPanel kind="session" onAction={() => undefined} />
          <HxErrorPanel kind="notFound" onAction={() => undefined} />
        </div>
      </Section>

      <Section title="HxDialog / HxConfirmActionDialog">
        <div className="flex gap-3">
          <HxButton variant="secondary" onClick={() => setDialogOpen(true)}>モーダルを開く</HxButton>
          <HxButton variant="danger" onClick={() => setConfirmOpen(true)}>確認ダイアログを開く</HxButton>
        </div>
        <HxDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="汎用モーダル"
          description="Esc・フォーカストラップ・フォーカス復帰に対応しています。"
          footer={<HxButton variant="secondary" onClick={() => setDialogOpen(false)}>閉じる</HxButton>}
        >
          <p>短い確認や軽い編集に限定して使います。</p>
        </HxDialog>
        <HxConfirmActionDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => setConfirmOpen(false)}
          subject="受信問診 Q-20261105-0001"
          title="受領を確認しますか"
          description="この問診票を受領した記録が残ります。この操作は取り消せません。"
          confirmLabel="受領を確認する"
          tone="primary"
        />
      </Section>

      <Section title="HxAppShell（枠内プレビュー）">
        <div className="h-[420px] rounded-md border border-hx-border">
          <HxAppShell
            framed
            facilityName="さくら合成クリニック"
            staffName="合成 職員"
            onSignOut={() => undefined}
            navItems={[
              { href: "/dev/catalog#inbox", label: "受信問診", icon: "inbox", active: true },
              { href: "/dev/catalog#staff", label: "職員管理", icon: "users" },
              { href: "/dev/catalog#settings", label: "施設設定", icon: "settings" },
            ]}
          >
            <HxPageHeader title="受信問診" description="シェルの枠内プレビューです。" />
            <HxSkeleton className="h-24 w-full" />
          </HxAppShell>
        </div>
      </Section>
    </div>
  );
}
