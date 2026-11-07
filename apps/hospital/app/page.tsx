import Link from "next/link";
import { PortalHeader } from "../components/layout/portal-header";

export default function Home() {
  return (
    <div className="min-h-screen">
      <PortalHeader />
      <main id="hx-main-content" tabIndex={-1} className="mx-auto max-w-5xl space-y-6 px-6 py-10">
        <h1 className="text-hx-page-title font-bold">医療機関ポータル</h1>
        <p className="text-hx-body text-hx-text-subtle">利用できる機能を選択してください。</p>
        <div>
          <Link
            href="/operator"
            className="inline-flex h-10 items-center rounded-md bg-hx-primary px-4 font-semibold text-hx-on-primary hover:bg-hx-primary-hover"
          >
            運営管理者：失敗ジョブの確認
          </Link>
        </div>
        <p className="text-hx-body text-hx-text-subtle">
          職員の受信・閲覧画面は準備中です。
        </p>
      </main>
    </div>
  );
}
