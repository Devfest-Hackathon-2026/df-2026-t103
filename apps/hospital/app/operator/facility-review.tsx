"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api-client";
import { firebaseClient } from "../../lib/firebase-client";
import type { Page, ReviewChecks, ReviewFacility, VerificationSummary } from "../../lib/facility-review";

const statuses = { pending: "未審査", verified: "承認済み", rejected: "却下", suspended: "停止中" };
const checkLabels: Record<keyof ReviewChecks, string> = { existence: "施設の実在", applicant: "申請者の真正性", receiverContact: "受信担当者", location: "所在地" };
type Confirmation = { decision: "verified" | "rejected"; checks: ReviewChecks; verificationRecordId: string; reason: string };

export default function FacilityReview() {
  const [page, setPage] = useState<Page<ReviewFacility> | null>(null);
  const [selected, setSelected] = useState<ReviewFacility | null>(null);
  const [records, setRecords] = useState<Page<VerificationSummary> | null>(null);
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [decision, setDecision] = useState<"verified" | "rejected">("verified");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const confirmButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (pending) confirmButton.current?.focus(); }, [pending]);
  function begin() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setMessage("");
    return controller;
  }
  function errorMessage(error: unknown) { return error instanceof ApiError ? error.message : "一覧を取得できませんでした。接続設定・MFAと通信状態を確認してください。"; }
  async function load(cursor?: string) {
    const controller = begin();
    setPage(null); setSelected(null); setRecords(null); setPending(null);
    try {
      const result = await firebaseClient().api.reviewFacilities(cursor, controller.signal);
      if (!controller.signal.aborted) setPage(result);
    } catch (error) { if (!controller.signal.aborted) setMessage(errorMessage(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function select(facility: ReviewFacility, cursor?: string) {
    const controller = begin();
    setSelected(facility); setRecords(null); setPending(null); setDecision("verified");
    try {
      const result = await firebaseClient().api.verificationRecords(facility.facilityId, cursor, controller.signal);
      if (!controller.signal.aborted) setRecords(result);
    } catch (error) { if (!controller.signal.aborted) setMessage(errorMessage(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const checks: ReviewChecks = { existence: data.has("existence"), applicant: data.has("applicant"), receiverContact: data.has("receiverContact"), location: data.has("location") };
    const verificationRecordId = String(data.get("verificationRecordId") ?? "").trim();
    const reason = String(data.get("reason") ?? "").trim();
    if (!verificationRecordId || (decision === "verified" && !Object.values(checks).every(Boolean)) || (decision === "rejected" && !reason)) { setMessage("承認には4項目の確認が必要です。文書参照と、却下の場合は理由を入力してください。"); return; }
    setMessage(""); setPending({ decision, checks, verificationRecordId, reason });
    event.currentTarget.reset();
  }
  async function submit() {
    if (!selected || !pending || mutating.current) return;
    mutating.current = true;
    const controller = begin();
    try {
      await firebaseClient().api.reviewFacility(selected.facilityId, pending.decision, pending, controller.signal);
      if (!controller.signal.aborted) {
        setMessage(`施設 ${selected.facilityId} の${pending.decision === "verified" ? "承認" : "却下"}を確認しました。一覧を再取得して最新状態を確認してください。`);
        setPending(null); setSelected(null); setRecords(null); setPage(null);
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof ApiError && error.status < 500 ? error.message : "審査結果を確認できませんでした。処理済みの可能性があります。一覧と証跡を再取得して確認してください。自動再試行は行いません。");
    } finally { mutating.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  return <section aria-labelledby="review-title" className="space-y-4 rounded border p-5">
    <h2 id="review-title" className="text-xl font-bold">運営施設審査</h2>
    <p>登録施設を新しい順に表示します。連絡先・審査メモ・文書参照の原文は一覧に表示しません。承認しても受信機能は自動で有効になりません。</p>
    <button type="button" disabled={busy} onClick={() => load()} className="rounded bg-blue-900 px-4 py-2 text-white disabled:opacity-50">施設一覧を取得・再試行</button>
    {message && <p role="status">{message}</p>}
    <div aria-live="polite" aria-busy={busy}>
      {page?.items.length === 0 && <p>登録施設はありません。</p>}
      {page && page.items.length > 0 && <ul data-review-facilities className="space-y-3">{page.items.map((facility) => <li key={facility.facilityId} className="rounded border p-3">
        <p>{facility.legalName}（{facility.displayName}）</p><p>施設ID: {facility.facilityId} / {statuses[facility.verificationStatus]}</p>
        <button type="button" disabled={busy || !!pending} onClick={() => select(facility)} className="underline">施設 {facility.facilityId} の審査・証跡</button>
      </li>)}</ul>}
      {page?.nextCursor && <button type="button" disabled={busy || !!pending} onClick={() => load(page.nextCursor!)} className="underline">施設一覧の次のページ</button>}
    </div>
    {selected && <div className="space-y-4 rounded border p-4">
      <h3 className="font-bold">対象: {selected.legalName}（{selected.facilityId}） / {statuses[selected.verificationStatus]}</h3>
      <button type="button" disabled={busy || !!pending} onClick={() => select(selected)} className="underline">検証証跡を再取得</button>
      {records?.items.length === 0 && <p>検証証跡はまだありません。</p>}
      {records && records.items.length > 0 && <ul data-verification-records className="space-y-3">{records.items.map((item) => <li key={item.recordId}><p>{item.createdAt ?? "日時不明"}（UTC） / {item.decision === "verified" ? "承認" : "却下"}</p><p>{(Object.keys(checkLabels) as (keyof ReviewChecks)[]).map((key) => `${checkLabels[key]}: ${item.checks[key] ? "確認済み" : "未確認"}`).join(" / ")}</p></li>)}</ul>}
      {records?.nextCursor && <button type="button" disabled={busy || !!pending} onClick={() => select(selected, records.nextCursor!)} className="underline">証跡の次のページ</button>}
      {records && selected.verificationStatus !== "verified" && !pending && <form data-facility-review-form method="post" onSubmit={prepare} className="space-y-4">
        <p>原本を別途確認してください。患者情報や認証情報は入力しないでください。</p>
        <fieldset disabled={busy} className="space-y-2"><legend>4検証項目（承認は全項目が必須）</legend>{(Object.keys(checkLabels) as (keyof ReviewChecks)[]).map((key) => <label key={key} className="block"><input type="checkbox" name={key} /> {checkLabels[key]}</label>)}</fieldset>
        <label className="block">検証文書参照<input name="verificationRecordId" required maxLength={200} autoComplete="off" className="block w-full rounded border p-2" /></label>
        <label className="block">審査結果<select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)} className="ml-2 rounded border p-2"><option value="verified">承認</option>{selected.verificationStatus === "pending" && <option value="rejected">却下</option>}</select></label>
        {decision === "rejected" && <label className="block">却下理由<textarea name="reason" required maxLength={500} className="block w-full rounded border p-2" /></label>}
        <button disabled={busy} className="rounded border px-4 py-2">審査内容を確認</button>
      </form>}
      {pending && <div data-review-confirmation className="space-y-3"><p>施設 {selected.facilityId} を{pending.decision === "verified" ? "承認" : "却下"}します。対象と確認内容を再確認してください。</p><p>{(Object.keys(checkLabels) as (keyof ReviewChecks)[]).map((key) => `${checkLabels[key]}: ${pending.checks[key] ? "確認済み" : "未確認"}`).join(" / ")}</p><p>検証文書参照: {pending.verificationRecordId}</p>{pending.reason && <p>却下理由: {pending.reason}</p>}
        <button ref={confirmButton} type="button" disabled={busy} onClick={submit} className="rounded bg-blue-900 px-4 py-2 text-white">この審査結果を確定する</button><button type="button" disabled={busy} onClick={() => { setPending(null); setMessage(""); }} className="ml-4 underline">審査の確認を取り消す</button>
      </div>}
    </div>}
  </section>;
}
