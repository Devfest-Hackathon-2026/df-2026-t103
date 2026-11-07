"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { HxBadge } from "../../../components/design-system/hx-status-badge";
import { HxButton } from "../../../components/design-system/hx-button";
import { HxDialog } from "../../../components/design-system/hx-dialog";
import { HxEmptyState, HxErrorPanel, type HxErrorKind } from "../../../components/design-system/hx-feedback";
import { HxField } from "../../../components/design-system/hx-field";
import { HxIcon } from "../../../components/design-system/hx-icon";
import { HxPageHeader } from "../../../components/design-system/hx-page-header";
import { HxSkeletonRows } from "../../../components/design-system/hx-skeleton";
import { HxDataTable } from "../../../components/design-system/hx-data-table";
import { useSelectedFacility } from "../workspace-shell";
import { hxApi, HxApiError } from "../../../lib/hx-api";

interface FacilitySettings {
  facilityId: string;
  legalName: string;
  displayName: string;
  formattedAddress: string;
  verificationStatus: "pending" | "verified" | "rejected" | "suspended";
  receivingEnabled: boolean;
  receivingDisabledBy: "platform" | "staff" | null;
  receivingDisabledAt: string | null;
  receivingDisabledReason: string | null;
}

const VERIFICATION_LABEL: Record<FacilitySettings["verificationStatus"], string> = {
  pending: "審査中",
  verified: "審査済み",
  rejected: "審査否認",
  suspended: "停止中",
};

const VERIFICATION_TONE: Record<FacilitySettings["verificationStatus"], "success" | "warning" | "danger" | "neutral"> = {
  pending: "warning",
  verified: "success",
  rejected: "danger",
  suspended: "neutral",
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

function errorKind(err: unknown): HxErrorKind {
  if (!(err instanceof HxApiError)) return "error";
  if (err.status === 401) return "session";
  if (err.status === 403) return "forbidden";
  if (err.status === 0) return "offline";
  return "error";
}

export function SettingsClient() {
  const selected = useSelectedFacility();
  const facilityId = selected?.facilityId ?? null;
  const isAdmin = selected?.role === "facility_admin";

  // facilityId とセットで保持し、施設切替直後に前施設の設定が残らないようにする
  const [data, setData] = useState<{ facilityId: string; res: FacilitySettings } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ kind: HxErrorKind; message: string } | null>(null);
  const reqSeqRef = useRef(0);

  const settings = data && data.facilityId === facilityId ? data.res : null;

  const [toggleOpen, setToggleOpen] = useState<"stop" | "resume" | null>(null);
  const [reason, setReason] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!facilityId || !isAdmin) return Promise.resolve();
    const reqId = ++reqSeqRef.current;
    const url = `hospitals/${encodeURIComponent(facilityId)}/settings`;
    return Promise.resolve()
      .then(() => {
        if (reqId !== reqSeqRef.current) return undefined;
        setLoading(true);
        setError(null);
        return hxApi<FacilitySettings>(url);
      })
      .then((res) => {
        if (!res || reqId !== reqSeqRef.current) return;
        setData({ facilityId, res });
      })
      .catch((err: unknown) => {
        if (reqId !== reqSeqRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError({ kind: errorKind(err), message: err instanceof HxApiError ? err.message : "読み込みに失敗しました。" });
      })
      .finally(() => {
        if (reqId === reqSeqRef.current) setLoading(false);
      });
  }, [facilityId, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  function openToggle(kind: "stop" | "resume") {
    setReason("");
    setActionError(null);
    setToggleOpen(kind);
  }

  async function submitToggle(event: FormEvent) {
    event.preventDefault();
    if (!facilityId || !toggleOpen || actionBusy) return;
    const enabling = toggleOpen === "resume";
    setActionBusy(true);
    setActionError(null);
    try {
      await hxApi(`hospitals/${encodeURIComponent(facilityId)}/settings`, {
        method: "PATCH",
        body: enabling ? { receivingEnabled: true } : { receivingEnabled: false, reason: reason.trim() },
      });
      setToggleOpen(null);
      await load();
    } catch (err) {
      if (err instanceof HxApiError && err.code === "REAUTH_REQUIRED") {
        // 直近認証の期限切れ。再試行しても成功しないため再ログインへ誘導する
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/api/session/logout");
        return;
      }
      setActionError(
        err instanceof HxApiError && err.status === 409
          ? "運営による受付停止のため、施設側では再開できません。運営へお問い合わせください。"
          : err instanceof HxApiError
            ? err.message
            : "変更に失敗しました。もう一度お試しください。",
      );
    } finally {
      setActionBusy(false);
    }
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 pt-8">
        <HxEmptyState
          icon="building"
          title="施設が選択されていません"
          description="施設設定を行うには、まず業務を行う施設を選択してください。"
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

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <HxPageHeader title="施設設定" />
        <HxErrorPanel
          kind="forbidden"
          description="施設設定の閲覧・変更は施設管理者（facility_admin）のみが行えます。"
        />
      </div>
    );
  }

  const stopping = settings ? !settings.receivingEnabled : false;
  const platformStopped = stopping && settings!.receivingDisabledBy !== "staff";

  return (
    <div className="space-y-5">
      <HxPageHeader
        title="施設設定"
        description={`${selected.facility?.displayName ?? "選択中の施設"}の施設情報と受付設定です。`}
      />

      {error ? (
        error.kind === "session" ? (
          <HxErrorPanel
            kind="session"
            description={error.message}
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            onAction={() => window.location.assign("/api/session/logout")}
          />
        ) : (
          <HxErrorPanel
            kind={error.kind}
            description={error.kind === "forbidden" ? undefined : error.message}
            onAction={error.kind === "forbidden" ? undefined : () => void load()}
          />
        )
      ) : settings === null ? (
        <HxDataTable caption="施設設定を読み込み中" busy={loading}>
          <tbody>
            <HxSkeletonRows rows={4} columns={2} />
          </tbody>
        </HxDataTable>
      ) : (
        <>
          <section aria-labelledby="facility-info-heading" className="space-y-3">
            <h2 id="facility-info-heading" className="text-hx-section-title font-semibold">
              施設情報（宛先確認）
            </h2>
            <dl className="divide-y divide-hx-border rounded-md border border-hx-border bg-hx-surface">
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
                <dt className="text-hx-body text-hx-text-subtle">正式名称</dt>
                <dd className="text-hx-body font-medium">{settings.legalName}</dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
                <dt className="text-hx-body text-hx-text-subtle">表示名</dt>
                <dd className="text-hx-body font-medium">{settings.displayName}</dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
                <dt className="text-hx-body text-hx-text-subtle">所在地</dt>
                <dd className="text-hx-body font-medium">
                  {settings.formattedAddress || "（未登録）"}
                </dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
                <dt className="text-hx-body text-hx-text-subtle">審査ステータス</dt>
                <dd className="text-hx-body">
                  <HxBadge tone={VERIFICATION_TONE[settings.verificationStatus]}>
                    {VERIFICATION_LABEL[settings.verificationStatus]}
                  </HxBadge>
                </dd>
              </div>
            </dl>
            <p className="flex items-start gap-2 text-hx-caption text-hx-text-subtle">
              <HxIcon name="info" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              正式名称・表示名・所在地は患者の宛先確認に使われる審査済みの情報です。
              変更には運営の再審査が必要なためこの画面では変更できません。変更が必要な場合は運営へお問い合わせください。
            </p>
          </section>

          <section aria-labelledby="receiving-heading" className="space-y-3">
            <h2 id="receiving-heading" className="text-hx-section-title font-semibold">
              受付設定
            </h2>
            <div className="space-y-4 rounded-md border border-hx-border bg-hx-surface px-4 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-hx-body text-hx-text-subtle">現在の受付状態</span>
                {settings.receivingEnabled ? (
                  <HxBadge tone="success">受付中</HxBadge>
                ) : (
                  <HxBadge tone="danger">受付停止中</HxBadge>
                )}
              </div>

              {stopping ? (
                <dl className="space-y-1 text-hx-caption text-hx-text-subtle">
                  <div className="flex gap-2">
                    <dt>停止日時:</dt>
                    <dd>{formatDateTime(settings.receivingDisabledAt)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>停止理由:</dt>
                    <dd>{settings.receivingDisabledReason ?? "—"}</dd>
                  </div>
                </dl>
              ) : null}

              <p className="text-hx-caption text-hx-text-subtle">
                受付を停止すると、患者からの新しい問診票の配送が止まります。
                すでに受信した問診票は引き続き閲覧できます。
              </p>

              {platformStopped ? (
                <p className="flex items-start gap-2 rounded-sm bg-hx-warning-bg px-3 py-2 text-hx-caption text-hx-warning">
                  <HxIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  運営によって受付が停止されています。再開には運営の対応が必要です。運営へお問い合わせください。
                </p>
              ) : null}

              <div>
                {settings.receivingEnabled ? (
                  <HxButton variant="danger" onClick={() => openToggle("stop")}>
                    受付を停止する
                  </HxButton>
                ) : (
                  <HxButton
                    variant="secondary"
                    disabled={platformStopped}
                    onClick={() => openToggle("resume")}
                  >
                    受付を再開する
                  </HxButton>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      <HxDialog
        open={toggleOpen !== null}
        onClose={
          actionBusy
            ? () => undefined
            : () => {
                setActionError(null);
                setToggleOpen(null);
              }
        }
        title={toggleOpen === "stop" ? "受付を停止しますか？" : "受付を再開しますか？"}
        description={
          toggleOpen === "stop"
            ? "患者からの新しい問診票の配送が止まります。すでに受信した問診票は引き続き閲覧できます。"
            : "患者からの新しい問診票の受付を再開します。"
        }
        footer={
          <>
            <HxButton
              variant="secondary"
              disabled={actionBusy}
              onClick={() => {
                setActionError(null);
                setToggleOpen(null);
              }}
            >
              キャンセル
            </HxButton>
            <HxButton
              type="submit"
              form="receiving-toggle-form"
              variant={toggleOpen === "stop" ? "danger" : "primary"}
              loading={actionBusy}
            >
              {toggleOpen === "stop" ? "停止する" : "再開する"}
            </HxButton>
          </>
        }
      >
        <form id="receiving-toggle-form" onSubmit={submitToggle} className="space-y-4">
          {toggleOpen === "stop" ? (
            <HxField
              label="停止理由"
              required
              error={actionError ?? undefined}
              description="患者や運営からの問い合わせ対応に使います。"
            >
              <textarea
                required
                maxLength={500}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="block w-full rounded-sm border border-hx-border px-3 py-2 text-hx-body"
                data-autofocus
              />
            </HxField>
          ) : actionError ? (
            <p role="alert" className="text-hx-body text-hx-danger">
              {actionError}
            </p>
          ) : null}
        </form>
      </HxDialog>
    </div>
  );
}
