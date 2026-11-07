"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, type AuditSummaryPage } from "../../lib/api-client";
import { firebaseClient } from "../../lib/firebase-client";

const labels: Record<string, string> = {
  patient: "患者", staff: "職員", platform: "運営", service: "システム", unknown: "不明",
  allow: "許可", deny: "拒否", success: "成功", failure: "失敗", other: "その他",
  STAFF_INVITED: "職員招待", STAFF_MEMBERSHIP_UPDATED: "職員権限・状態変更",
  MEMBERSHIP_REVOKED: "所属権限失効", FACILITY_RECEIVING_DISABLED: "施設受信停止",
  FACILITY_VERIFIED: "施設審査承認", AUDIT_EVENTS_LISTED: "監査一覧閲覧",
  JOB_FAILURES_LISTED: "失敗ジョブ一覧閲覧", AUTH_FAIL: "認証失敗", UNKNOWN: "未分類",
};

export default function AuditMonitor() {
  const [page, setPage] = useState<AuditSummaryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load(cursor?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setMessage(""); setPage(null);
    try {
      const result = await firebaseClient().api.auditEvents(cursor, controller.signal);
      if (!controller.signal.aborted) setPage(result);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof ApiError ? error.message : "監査一覧を取得できませんでした。接続設定・MFAと通信状態を確認してください。");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <section aria-labelledby="audit-title" className="space-y-4 rounded border p-5">
    <h2 id="audit-title" className="text-xl font-bold">権限・監査イベントの監視</h2>
    <p>新しい順に表示します。患者・職員・施設の識別子や記録の詳細は表示しません。日時はUTCです。</p>
    <button type="button" disabled={busy} onClick={() => load()} className="rounded bg-blue-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "監査一覧を読み込み中…" : "監査一覧を取得・再試行"}</button>
    {message && <p role="alert">{message}</p>}
    <div aria-live="polite" aria-busy={busy}>
      {page?.items.length === 0 && <p>監査イベントはありません。</p>}
      {page && page.items.length > 0 && <div className="overflow-x-auto"><table data-audit-summary className="w-full text-left">
        <caption className="py-3 text-left">権限変更・操作の監査サマリー</caption>
        <thead><tr><th scope="col">日時（UTC）</th><th scope="col">イベント</th><th scope="col">操作者区分</th><th scope="col">認可判断</th><th scope="col">結果</th></tr></thead>
        <tbody>{page.items.map((item) => <tr key={item.eventId} className="border-t"><td className="py-3">{item.occurredAt ?? "不明"}</td><td>{labels[item.action] ?? item.action}</td><td>{labels[item.actorType]}</td><td>{item.decision ? labels[item.decision] : "—"}</td><td>{item.outcome ? labels[item.outcome] : "—"}</td></tr>)}</tbody>
      </table></div>}
      {page?.nextCursor && <button type="button" disabled={busy} onClick={() => load(page.nextCursor!)} className="mt-4 underline">監査一覧の次のページ</button>}
    </div>
  </section>;
}
