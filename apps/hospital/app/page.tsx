import Link from "next/link";

export default function Home() {
  return <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
    <h1 className="text-2xl font-bold">もしもし問診 | 医療機関ポータル</h1>
    <p>利用できる機能を選択してください。</p>
    <Link href="/operator" className="inline-block rounded bg-blue-900 px-4 py-3 text-white">運営管理者：失敗ジョブの確認</Link>
    <p>職員の受信・閲覧画面は準備中です。</p>
  </main>;
}
