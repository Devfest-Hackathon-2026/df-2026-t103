export default function Home() {
  return (
    <>
      <header className="bg-slate-900 px-6 py-4 text-white"><p className="mx-auto max-w-5xl font-bold">もしもし問診 | 医療機関ポータル</p></header>
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
        <div className="rounded border border-amber-700 bg-amber-50 p-4 text-amber-950">
          <strong>デモ専用・実運用不可</strong>
          <p>認証、アクセス制御、問診の受信・閲覧は未実装です。実患者・実施設の情報を入力しないでください。</p>
        </div>
        <div><p className="text-sm font-semibold text-slate-600">画面イメージ</p><h1 className="mt-1 text-2xl font-bold">問診受信一覧</h1></div>
        <section aria-labelledby="inbox-heading" className="rounded border border-slate-300 bg-white p-6">
          <h2 id="inbox-heading" className="text-lg font-bold">受信一覧（未実装）</h2>
          <p className="mt-3 text-slate-700">データの取得・受信は行いません。以下は表示例の合成データです。</p>
          <div className="mt-5 overflow-x-auto"><table className="w-full min-w-96 text-left text-sm"><caption className="sr-only">合成データの表示例</caption><thead className="border-b border-slate-300"><tr><th scope="col" className="p-3">表示名</th><th scope="col" className="p-3">受信日時</th><th scope="col" className="p-3">状態</th></tr></thead><tbody><tr><td className="p-3">サンプル患者</td><td className="p-3">表示例</td><td className="p-3">表示例（受信なし）</td></tr></tbody></table></div>
        </section>
      </main>
    </>
  );
}
