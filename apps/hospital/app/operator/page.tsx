"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { getMultiFactorResolver, signInWithEmailAndPassword, signOut, TotpMultiFactorGenerator, type MultiFactorError, type MultiFactorResolver } from "firebase/auth";
import { ApiError, type JobFailurePage, type JobType } from "../../lib/api-client";
import AuditMonitor from "./audit-monitor";
import EmergencyStop from "./emergency-stop";
import { firebaseClient } from "../../lib/firebase-client";

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export default function OperatorPage() {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [signedIn, setSignedIn] = useState(false);
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [type, setType] = useState<JobType>("ocr");
  const [page, setPage] = useState<JobFailurePage | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    form.reset();
    setBusy(true); setMessage("");
    try {
      await signInWithEmailAndPassword(firebaseClient().auth, email, password);
      setSignedIn(true);
    } catch (error) {
      if ((error as { code?: string }).code === "auth/multi-factor-auth-required") {
        const next = getMultiFactorResolver(firebaseClient().auth, error as MultiFactorError);
        if (next.hints.some((hint) => hint.factorId === TotpMultiFactorGenerator.FACTOR_ID)) setResolver(next);
        else setMessage("このMFA方式は未対応です。認証アプリのTOTP設定を管理者へ確認してください。");
      } else setMessage("接続設定またはログイン情報を確認してください。");
    } finally { setBusy(false); }
  }

  async function confirmMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    event.currentTarget.reset();
    if (!resolver) return;
    setBusy(true); setMessage("");
    try {
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(String(data.get("factor")), String(data.get("code")));
      await resolver.resolveSignIn(assertion);
      setResolver(null); setSignedIn(true);
    } catch { setMessage("認証コードを確認してください。期限切れの場合はログインからやり直してください。"); }
    finally { setBusy(false); }
  }

  async function load(cursor?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setMessage(""); setPage(null);
    try {
      const result = await firebaseClient().api.jobFailures(type, cursor, controller.signal);
      if (!controller.signal.aborted) setPage(result);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof ApiError ? error.message : "取得できませんでした。接続設定・MFAと通信状態を確認してください。");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function logout() {
    request.current?.abort(); setPage(null); setResolver(null); setMessage("");
    try { await signOut(firebaseClient().auth); }
    catch { setMessage("ログアウトを完了できませんでした。このタブを閉じてください。"); }
    finally { setSignedIn(false); setBusy(false); }
  }

  return <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
    <Link href="/" className="underline">医療機関ポータルへ</Link>
    <h1 className="text-2xl font-bold">セキュリティ・配送監視</h1>
    <p>運営管理者専用です。患者の問診内容は表示しません。</p>
    {message && <p role="alert" className="rounded border border-red-700 p-4">{message}</p>}
    {!signedIn && !resolver && <form method="post" onSubmit={login} className="max-w-md space-y-4">
      <label className="block">メールアドレス<input name="email" type="email" autoComplete="username" required className="block w-full rounded border p-2" /></label>
      <label className="block">パスワード<input name="password" type="password" autoComplete="current-password" required className="block w-full rounded border p-2" /></label>
      <button disabled={busy || !hydrated} className="rounded bg-blue-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "ログイン中…" : "ログイン"}</button>
    </form>}
    {resolver && <form method="post" onSubmit={confirmMfa} className="max-w-md space-y-4">
      <label className="block">認証アプリ<select name="factor" className="block w-full rounded border p-2">{resolver.hints.filter((hint) => hint.factorId === TotpMultiFactorGenerator.FACTOR_ID).map((hint, index) => <option key={hint.uid} value={hint.uid}>{hint.displayName || `認証アプリ ${index + 1}`}</option>)}</select></label>
      <label className="block">認証コード<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required className="block w-full rounded border p-2" /></label>
      <button disabled={busy} className="rounded bg-blue-900 px-4 py-2 text-white">確認</button>
      <button type="button" disabled={busy} onClick={logout} className="ml-4 underline">ログインからやり直す</button>
    </form>}
    {signedIn && <>
      <div className="flex flex-wrap items-end gap-4">
        <label>種類<select value={type} disabled={busy} onChange={(event) => { request.current?.abort(); setPage(null); setMessage(""); setType(event.target.value as JobType); }} className="ml-2 rounded border p-2"><option value="ocr">画像処理</option><option value="deletion">削除処理</option></select></label>
        <button disabled={busy} onClick={() => load()} className="rounded bg-blue-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "読み込み中…" : "一覧を取得・再試行"}</button>
        <button onClick={logout} className="underline">ログアウト</button>
      </div>
      <section aria-live="polite" aria-busy={busy}>
        {page && page.items.length === 0 && <p>失敗ジョブはありません。</p>}
        {page && page.items.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left"><caption className="py-3 text-left">{type === "ocr" ? "画像処理" : "削除処理"}の失敗ジョブ</caption><thead><tr><th scope="col">ジョブID</th><th scope="col">失敗分類</th><th scope="col">試行回数</th><th scope="col">失敗日時</th></tr></thead><tbody>{page.items.map((item) => <tr key={`${item.type}:${item.jobId}`} className="border-t"><td className="py-3">{item.jobId}</td><td>{item.failureCode ?? "不明"}</td><td>{item.attempts}</td><td>{item.failedAt ?? "不明"}</td></tr>)}</tbody></table></div>}
        {page?.nextCursor && <button disabled={busy} onClick={() => load(page.nextCursor!)} className="mt-4 underline">次のページ</button>}
      </section>
      <AuditMonitor />
      <EmergencyStop />
    </>}
  </main>;
}
