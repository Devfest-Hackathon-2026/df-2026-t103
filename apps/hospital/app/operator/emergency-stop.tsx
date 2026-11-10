"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api-client";
import { firebaseClient } from "../../lib/firebase-client";

export default function EmergencyStop() {
  const [pending, setPending] = useState<
    | { kind: "disable"; facilityId: string; reason: string }
    | { kind: "enable"; facilityId: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const confirmation = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (pending) confirmation.current?.focus(); }, [pending]);

  function prepareDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const facilityId = String(data.get("facilityId") ?? "").trim();
    const reason = String(data.get("reason") ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(facilityId) || !reason || reason.length > 500) return;
    event.currentTarget.reset();
    setMessage(""); setPending({ kind: "disable", facilityId, reason });
  }

  function prepareEnable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const facilityId = String(data.get("facilityId") ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(facilityId)) return;
    event.currentTarget.reset();
    setMessage(""); setPending({ kind: "enable", facilityId });
  }

  async function execute() {
    if (!pending || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setMessage("");
    try {
      if (pending.kind === "disable") {
        await firebaseClient().api.disableFacility(pending.facilityId, pending.reason, controller.signal);
        if (!controller.signal.aborted) setMessage(`施設 ${pending.facilityId} の受信停止を確認しました。`);
      } else {
        await firebaseClient().api.enableFacility(pending.facilityId, controller.signal);
        if (!controller.signal.aborted) setMessage(`施設 ${pending.facilityId} の受信再開を確認しました。`);
      }
      if (!controller.signal.aborted) setPending(null);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof ApiError && error.status < 500
        ? error.message
        : "結果を確認できませんでした。処理済みの可能性があります。担当者に状態を確認し、必要な場合のみ再実行してください。");
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false); }
    }
  }

  return <section aria-labelledby="emergency-title" className="space-y-4 rounded border border-red-800 p-5">
    <h2 id="emergency-title" className="text-xl font-bold">施設受信の緊急停止</h2>
    <p>新しい送信の受信を停止します。既存の受信済みデータは削除されません。</p>
    <ol className="list-inside list-decimal space-y-2">
      <li>施設担当者と対象施設ID・停止の必要性を確認してください。</li>
      <li>直近にログインした運営管理者が、対象と理由を確認して停止を実行してください。</li>
      <li>完了後は担当者へ連絡し、原因調査と復旧の判断を行ってください。復旧が確認できたら受信再開を実行してください。</li>
    </ol>
    <p>停止理由に患者名・問診内容・認証情報を記載しないでください。</p>
    {message && <p role="status" className="rounded border p-3">{message}</p>}
    {!pending ? <div className="space-y-6">
      <form method="post" onSubmit={prepareDisable} className="max-w-lg space-y-4">
        <h3 className="font-bold">受信停止</h3>
        <label className="block">施設ID<input name="facilityId" required pattern="[A-Za-z0-9_-]{1,200}" maxLength={200} autoComplete="off" className="block w-full rounded border p-2" /></label>
        <label className="block">停止理由<textarea name="reason" required maxLength={500} className="block w-full rounded border p-2" /></label>
        <button className="rounded border border-red-800 px-4 py-2">停止内容を確認</button>
      </form>
      <form method="post" onSubmit={prepareEnable} className="max-w-lg space-y-4">
        <h3 className="font-bold">受信再開</h3>
        <p>施設側で解除できない運営停止を解除します。原因調査と復旧確認が済んでから実行してください。</p>
        <label className="block">施設ID<input name="facilityId" required pattern="[A-Za-z0-9_-]{1,200}" maxLength={200} autoComplete="off" className="block w-full rounded border p-2" /></label>
        <button className="rounded border px-4 py-2">再開対象を確認</button>
      </form>
    </div> : <div className="space-y-3" aria-busy={busy}>
      <p>施設ID: <strong>{pending.facilityId}</strong></p>
      {pending.kind === "disable" ? (
        <>
          <p className="whitespace-pre-wrap">停止理由: {pending.reason}</p>
          <p>対象を確認してください。実行するとこの施設の受信を停止します。</p>
          <button ref={confirmation} type="button" disabled={busy} onClick={execute} className="rounded bg-red-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "停止処理中…" : "この施設の受信を停止する"}</button>
        </>
      ) : (
        <>
          <p>対象を確認してください。実行するとこの施設の受信を再開します。</p>
          <button ref={confirmation} type="button" disabled={busy} onClick={execute} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{busy ? "再開処理中…" : "この施設の受信を再開する"}</button>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => { setPending(null); setMessage(""); }} className="ml-4 underline">取り消す</button>
    </div>}
  </section>;
}
