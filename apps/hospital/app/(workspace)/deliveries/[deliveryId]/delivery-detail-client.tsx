"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { HxStatusBadge, type HxDeliveryStatus } from "../../../../components/design-system/hx-status-badge";
import { HxDataTable, HxTd, HxTh, HxTr } from "../../../../components/design-system/hx-data-table";
import { HxButton } from "../../../../components/design-system/hx-button";
import { HxConfirmActionDialog } from "../../../../components/design-system/hx-dialog";
import { HxEmptyState, HxErrorPanel, type HxErrorKind } from "../../../../components/design-system/hx-feedback";
import { HxPageHeader } from "../../../../components/design-system/hx-page-header";
import { HxSkeletonRows } from "../../../../components/design-system/hx-skeleton";
import { useSelectedFacility } from "../../workspace-shell";
import { hxApi, HxApiError } from "../../../../lib/hx-api";

/** GET /v1/hospitals/{facilityId}/deliveries/{deliveryId} の応答型（API契約と一致させる）。 */
interface SummarySection {
  value: string | null;
  source: string | null;
  answerState: "answered" | "unknown" | "skipped" | "not_asked";
}

interface QuestionnaireSnapshot {
  schemaVersion?: string;
  /** 契約は {value} だが、旧データの生文字列も安全側で受ける */
  chiefComplaint?: { value: string | null; source?: string } | string;
  sections?: Record<string, SummarySection>;
  bodyLocations?: string[];
  medicationSnapshots?: Array<{ medicationId: string; displayName: string; confirmed: true }>;
  medicalHistorySnapshot?: Array<{ conditionText: string; source: string }>;
  unansweredTopics?: string[];
}

export function DeliveryQuestionnaireSummary({ snapshot }: { snapshot: QuestionnaireSnapshot }) {
  const complaint = snapshot.chiefComplaint;
  const chiefComplaintText =
    typeof complaint === "string" ? complaint : (complaint && typeof complaint === "object" && complaint.value) || "—";
  const sections = Object.entries(snapshot.sections ?? {})
    .filter(([, s]) => s && typeof s === "object" && typeof s.answerState === "string")
    .sort(([a], [b]) => {
      const order = Object.keys(TOPIC_LABEL);
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    });
  const unanswered = snapshot.unansweredTopics ?? [];

  return (
    <>
      <dl className="mb-4 space-y-2 text-hx-body">
        <div>
          <dt className="text-hx-caption text-hx-text-subtle">主訴</dt>
          <dd className="font-semibold whitespace-pre-wrap">{chiefComplaintText}</dd>
        </div>
        {snapshot.bodyLocations && snapshot.bodyLocations.length > 0 ? (
          <div>
            <dt className="text-hx-caption text-hx-text-subtle">症状の部位</dt>
            <dd>{snapshot.bodyLocations.map((loc) => BODY_LOCATION_LABEL[loc] ?? loc).join("、")}</dd>
          </div>
        ) : null}
      </dl>
      {sections.length > 0 ? (
        <HxDataTable caption="問診票の回答項目">
          <thead><tr><HxTh className="w-56">項目</HxTh><HxTh>回答</HxTh></tr></thead>
          <tbody>
            {sections.map(([topic, section]) => (
              <HxTr key={topic}>
                <th scope="row" className="border-b border-hx-divider px-3 py-2.5 text-left align-middle font-semibold">
                  {TOPIC_LABEL[topic] ?? topic}
                </th>
                <HxTd className="whitespace-pre-wrap">
                  {section.answerState === "answered" && section.value
                    ? section.value
                    : (ANSWER_STATE_LABEL[section.answerState] ?? "—")}
                </HxTd>
              </HxTr>
            ))}
          </tbody>
        </HxDataTable>
      ) : null}
      {unanswered.length > 0 ? (
        <p className="mt-3 text-hx-caption text-hx-text-subtle">
          未回答の項目: {unanswered.map((t) => TOPIC_LABEL[t] ?? t).join("、")}
        </p>
      ) : null}
    </>
  );
}

interface PatientIdentity {
  familyName?: string;
  givenName?: string;
  familyNameKana?: string;
  givenNameKana?: string;
  birthDate?: string;
  phoneNumber?: string;
}

interface DeliveryDetail {
  deliveryId: string;
  facilityId: string;
  questionnaireId: string;
  questionnaireRevisionId: string;
  status: HxDeliveryStatus;
  shareScope: Record<string, unknown>;
  patientIdentitySnapshot: PatientIdentity;
  questionnaireSnapshot: QuestionnaireSnapshot;
  snapshotSha256: string;
  createdAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
}

const TOPIC_LABEL: Record<string, string> = {
  onset_timing: "発症時期",
  severity: "症状の強さ",
  frequency: "頻度",
  life_impact: "日常生活への影響",
  associated_symptoms: "随伴症状",
  current_medication: "服薬状況",
  medical_history: "既往歴",
  allergy: "アレルギー",
};

const ANSWER_STATE_LABEL: Record<SummarySection["answerState"], string> = {
  answered: "",
  unknown: "分からない",
  skipped: "回答をスキップ",
  not_asked: "未出題",
};

const BODY_LOCATION_LABEL: Record<string, string> = {
  whole_body: "全身",
  head: "頭",
  face: "顔",
  neck: "首",
  throat: "のど",
  chest: "胸",
  abdomen: "腹部",
  upper_back: "背中（上）",
  lower_back: "腰・背中（下）",
  left_shoulder: "左肩",
  right_shoulder: "右肩",
  left_arm: "左腕",
  right_arm: "右腕",
  left_hand: "左手",
  right_hand: "右手",
  left_leg: "左足（下肢）",
  right_leg: "右足（下肢）",
  left_knee: "左膝",
  right_knee: "右膝",
  left_foot: "左足（足先）",
  right_foot: "右足（足先）",
  skin: "皮膚",
  other: "その他",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function identityName(identity: PatientIdentity): string {
  return [identity.familyName, identity.givenName]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

export function DeliveryDetailClient({ deliveryId }: { deliveryId: string }) {
  const selected = useSelectedFacility();
  const facilityId = selected?.facilityId ?? null;

  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ kind: HxErrorKind; message: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const reqSeqRef = useRef(0);
  const statusRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!facilityId) return Promise.resolve();
    const reqId = ++reqSeqRef.current;
    const url = `hospitals/${encodeURIComponent(facilityId)}/deliveries/${encodeURIComponent(deliveryId)}`;
    return Promise.resolve()
      .then(() => {
        if (reqId !== reqSeqRef.current) return undefined;
        setLoading(true);
        setError(null);
        return hxApi<DeliveryDetail>(url);
      })
      .then((data) => {
        if (!data || reqId !== reqSeqRef.current) return;
        setDetail(data);
        setAckError(null);
      })
      .catch((err: unknown) => {
        if (reqId !== reqSeqRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message = err instanceof HxApiError ? err.message : "読み込みに失敗しました。";
        const kind: HxErrorKind =
          err instanceof HxApiError && err.status === 401
            ? "session"
            : err instanceof HxApiError && err.status === 403
              ? "forbidden"
              : err instanceof HxApiError && err.status === 404
                ? "notFound"
                : err instanceof HxApiError && err.status === 0
                  ? "offline"
                  : "error";
        setError({ kind, message });
      })
      .finally(() => {
        if (reqId === reqSeqRef.current) setLoading(false);
      });
  }, [facilityId, deliveryId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function acknowledge() {
    if (!facilityId || !detail || ackBusy) return;
    // 先行する load() の結果で acknowledged 状態を巻き戻さないよう要求世代を進める
    reqSeqRef.current += 1;
    setAckBusy(true);
    setAckError(null);
    try {
      const res = await hxApi<{ deliveryId: string; status: "acknowledged"; acknowledgedAt: string | null }>(
        `hospitals/${encodeURIComponent(facilityId)}/deliveries/${encodeURIComponent(detail.deliveryId)}/acknowledge`,
        { method: "POST" },
      );
      setDetail({ ...detail, status: res.status, acknowledgedAt: res.acknowledgedAt });
      setConfirmOpen(false);
      statusRef.current?.focus();
    } catch (err) {
      setConfirmOpen(false);
      setAckError(
        err instanceof HxApiError && err.status === 409
          ? "この問診票は現在の状態では受領確認できません。一覧を再読み込みして状態を確認してください。"
          : err instanceof HxApiError
            ? err.message
            : "受領確認に失敗しました。もう一度お試しください。",
      );
    } finally {
      setAckBusy(false);
    }
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 pt-8">
        <HxEmptyState
          icon="building"
          title="施設が選択されていません"
          description="問診詳細を表示するには、まず業務を行う施設を選択してください。"
        />
        <Link
          href="/facilities"
          className="inline-flex h-9 items-center rounded-sm bg-hx-primary px-4 text-hx-body font-semibold text-hx-on-primary"
        >
          施設を選択する
        </Link>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="space-y-4">
        <HxPageHeader title="問診詳細" />
        <HxDataTable caption="問診詳細を読み込み中" busy>
          <thead>
            <tr>
              <HxTh>項目</HxTh>
              <HxTh>内容</HxTh>
            </tr>
          </thead>
          <tbody>
            <HxSkeletonRows rows={6} columns={2} />
          </tbody>
        </HxDataTable>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <HxPageHeader title="問診詳細" />
        {error.kind === "session" ? (
          <HxErrorPanel
            kind="session"
            description={error.message}
            // セッション切れは Cookie クリア経由でログインへ戻す（他画面と同じ導線）
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            onAction={() => window.location.assign("/api/session/logout")}
          />
        ) : error.kind === "notFound" ? (
          <HxErrorPanel
            kind="notFound"
            description="指定された問診は存在しないか、この施設では表示できません。"
            onAction={() => {
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/deliveries");
            }}
          />
        ) : (
          <HxErrorPanel
            kind={error.kind}
            description={error.kind === "forbidden" ? undefined : error.message}
            onAction={error.kind === "forbidden" ? undefined : () => void load()}
          />
        )}
        <Link
          href="/deliveries"
          className="inline-flex h-9 items-center rounded-sm border border-hx-border bg-hx-surface px-4 text-hx-body font-semibold text-hx-text hover:bg-hx-surface-subtle"
        >
          一覧へ戻る
        </Link>
      </div>
    );
  }

  if (!detail) return null;

  const snapshot = detail.questionnaireSnapshot;
  const identity = detail.patientIdentitySnapshot;
  const name = identityName(identity);
  const kana = [identity.familyNameKana, identity.givenNameKana]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  // §18 状態別操作: created はまだ受信扱いにしない（不可）。delivered のみ受領可能
  const canAcknowledge = detail.status === "delivered";
  const medicationsShared = detail.shareScope.includeConfirmedMedications === true;
  const profileShared = detail.shareScope.includeProfile === true;

  return (
    <div className="space-y-5">
      <HxPageHeader
        title="問診詳細"
        description={name ? `${name} さんの問診票（確定版）` : "問診票（確定版）"}
      />

      <div className="flex flex-wrap items-center gap-3" ref={statusRef} tabIndex={-1}>
        <HxStatusBadge status={detail.status} />
        <p className="text-hx-caption text-hx-text-subtle">
          {detail.deliveredAt
            ? `受信: ${formatDateTime(detail.deliveredAt)}`
            : `作成: ${formatDateTime(detail.createdAt)}`}
          {detail.acknowledgedAt ? ` ／ 受領確認: ${formatDateTime(detail.acknowledgedAt)}` : ""}
        </p>
        <span role="status" className="sr-only">
          {detail.status === "acknowledged" ? "受領確認済みです" : ""}
        </span>
        <span className="flex-1" />
        <Link
          href="/deliveries"
          className="inline-flex h-9 items-center rounded-sm border border-hx-border bg-hx-surface px-4 text-hx-body font-semibold text-hx-text hover:bg-hx-surface-subtle"
        >
          一覧へ戻る
        </Link>
        {canAcknowledge ? (
          <HxButton onClick={() => setConfirmOpen(true)}>受領を確認する</HxButton>
        ) : null}
      </div>

      {ackError ? (
        <HxErrorPanel
          kind="error"
          title="受領確認できませんでした"
          description={ackError}
          actionLabel="状態を再読み込み"
          onAction={() => void load()}
        />
      ) : null}

      {detail.status === "revoked" || detail.status === "failed" ? (
        <HxErrorPanel
          kind="error"
          title={detail.status === "revoked" ? "この問診票は取り下げられています" : "この問診票の配送は失敗しています"}
          description="以下の内容は配送当時のスナップショットです。現在も有効な問診票ではありません。"
        />
      ) : null}

      <section aria-labelledby="patient-heading" className="rounded-md border border-hx-border bg-hx-surface p-5">
        <h2 id="patient-heading" className="mb-3 text-hx-section-title font-semibold">
          患者情報
        </h2>
        {name || kana || identity.birthDate || identity.phoneNumber ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-hx-body sm:grid-cols-2">
            {name ? (
              <div>
                <dt className="text-hx-caption text-hx-text-subtle">氏名</dt>
                <dd className="font-semibold">
                  {name}
                  {kana ? <span className="ml-2 font-normal text-hx-text-subtle">（{kana}）</span> : null}
                </dd>
              </div>
            ) : null}
            {!name && kana ? (
              <div>
                <dt className="text-hx-caption text-hx-text-subtle">フリガナ</dt>
                <dd>{kana}</dd>
              </div>
            ) : null}
            {identity.birthDate ? (
              <div>
                <dt className="text-hx-caption text-hx-text-subtle">生年月日</dt>
                <dd>{identity.birthDate}</dd>
              </div>
            ) : null}
            {identity.phoneNumber ? (
              <div>
                <dt className="text-hx-caption text-hx-text-subtle">電話番号</dt>
                <dd>{identity.phoneNumber}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-hx-body text-hx-text-subtle">
            患者は今回の送信で氏名・連絡先の共有を許可していません。
          </p>
        )}
      </section>

      <section aria-labelledby="questionnaire-heading" className="rounded-md border border-hx-border bg-hx-surface p-5">
        <h2 id="questionnaire-heading" className="mb-3 text-hx-section-title font-semibold">
          確定問診票
        </h2>
        <DeliveryQuestionnaireSummary snapshot={snapshot} />
      </section>

      <section aria-labelledby="medication-heading" className="rounded-md border border-hx-border bg-hx-surface p-5">
        <h2 id="medication-heading" className="mb-3 text-hx-section-title font-semibold">
          確認済みの薬剤
        </h2>
        {!medicationsShared ? (
          <p className="text-hx-body text-hx-text-subtle">
            患者は今回の送信で薬剤情報の共有を許可していません。
          </p>
        ) : snapshot.medicationSnapshots && snapshot.medicationSnapshots.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-hx-body whitespace-pre-wrap">
            {snapshot.medicationSnapshots.map((m) => (
              <li key={m.medicationId}>{m.displayName}</li>
            ))}
          </ul>
        ) : (
          <p className="text-hx-body text-hx-text-subtle">共有された薬剤情報はありません。</p>
        )}
      </section>

      <section aria-labelledby="history-heading" className="rounded-md border border-hx-border bg-hx-surface p-5">
        <h2 id="history-heading" className="mb-3 text-hx-section-title font-semibold">
          既往歴
        </h2>
        {!profileShared ? (
          <p className="text-hx-body text-hx-text-subtle">
            患者は今回の送信でプロフィール情報の共有を許可していません。
          </p>
        ) : snapshot.medicalHistorySnapshot && snapshot.medicalHistorySnapshot.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-hx-body whitespace-pre-wrap">
            {snapshot.medicalHistorySnapshot.map((h, i) => (
              <li key={i}>{h.conditionText}</li>
            ))}
          </ul>
        ) : (
          <p className="text-hx-body text-hx-text-subtle">共有された既往歴はありません。</p>
        )}
      </section>

      <p className="text-hx-caption text-hx-text-subtle">
        問診票ID: <span className="font-mono">{detail.questionnaireId}</span>
        <span className="ml-3">版: rev-{detail.questionnaireRevisionId}</span>
        <span className="ml-3 font-mono">{detail.snapshotSha256.slice(0, 12)}…</span>（送信版ハッシュ）
      </p>

      <HxConfirmActionDialog
        open={confirmOpen}
        subject={
          name ? `${name} さんの問診票` : `問診票（ID: ${detail.questionnaireId}）`
        }
        title="受領を確認しますか？"
        description="「受領確認」は診療の予約ではなく、医療機関がこの問診票を受け取ったことを記録する操作です。確認すると一覧の状態が「受領確認済み」に変わります。"
        confirmLabel="受領を確認する"
        busy={ackBusy}
        onConfirm={() => void acknowledge()}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}
