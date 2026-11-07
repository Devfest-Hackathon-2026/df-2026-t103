"use client";

import { useState } from "react";
import { HxButton } from "../../../components/design-system/hx-button";
import { HxEmptyState } from "../../../components/design-system/hx-feedback";
import { HxIcon } from "../../../components/design-system/hx-icon";
import { HxPageHeader } from "../../../components/design-system/hx-page-header";
import { HxBadge } from "../../../components/design-system/hx-status-badge";
import { STAFF_ROLE_LABEL, type StaffMembership } from "../../../lib/memberships";
import { useMemberships, useSelectedFacility } from "../workspace-shell";

const VERIFICATION_LABEL = {
  verified: { label: "確認済み", tone: "success" },
  pending: { label: "審査中", tone: "info" },
  rejected: { label: "未承認", tone: "danger" },
  suspended: { label: "利用停止", tone: "warning" },
} as const;

function verificationOf(facility: { verificationStatus: string }) {
  return (
    VERIFICATION_LABEL[facility.verificationStatus as keyof typeof VERIFICATION_LABEL] ??
    ({ label: "不明", tone: "neutral" } as const)
  );
}

/**
 * H-002 施設選択。選択は /api/facility-context がメンバーシップ照合後に
 * Cookie へ書き込み、切替時は施設別の画面状態を引き継がないよう全面遷移する。
 */
export function FacilitiesClient() {
  const memberships = useMemberships();
  const selected = useSelectedFacility();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function select(m: StaffMembership) {
    setBusyId(m.membershipId);
    setMessage("");
    try {
      const response = await fetch("/api/facility-context", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hx-client": "portal" },
        body: JSON.stringify({ facilityId: m.facilityId }),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      if (!response.ok) {
        if (response.status === 401) {
          // セッション失効は Cookie 消去込みでログインへ戻す
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Cookie消去はRoute Handler側で行う必要がある
          location.assign("/api/session/logout");
          return;
        }
        setMessage("施設を選択できませんでした。時間をおいて再試行してください。");
        return;
      }
      // 施設別状態（一覧・詳細・検索条件）を引き継がないため全面遷移する
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 施設コンテキストの完全リセットが目的
      location.assign("/deliveries");
    } catch {
      setMessage("通信できませんでした。接続状態を確認してください。");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <HxPageHeader
        title="施設の選択"
        description="業務を行う施設を選んでください。施設ごとの表示内容・検索条件は切り替わります。"
      />
      {message ? (
        <p role="alert" className="text-hx-body font-semibold text-hx-danger">
          {message}
        </p>
      ) : null}
      {memberships.length === 0 ? (
        <HxEmptyState
          icon="building"
          title="所属施設がありません"
          description="施設の管理者に職員招待を依頼してください。"
        />
      ) : (
        <ul className="space-y-3">
          {memberships.map((m) => {
            const isSelected = selected?.membershipId === m.membershipId;
            const selectable = m.facility !== null;
            return (
              <li
                key={m.membershipId}
                className={`rounded-md border bg-hx-surface p-4 ${
                  isSelected ? "border-hx-primary" : "border-hx-border"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-hx-body font-semibold">
                      {m.facility?.displayName ?? "施設情報を取得できません"}
                    </p>
                    {m.facility?.addressFormatted ? (
                      <p className="flex items-center gap-1.5 text-hx-caption text-hx-text-subtle">
                        <HxIcon name="building" size={14} />
                        {m.facility.addressFormatted}
                      </p>
                    ) : null}
                    <p className="text-hx-caption text-hx-text-subtle">
                      役割：{STAFF_ROLE_LABEL[m.role] ?? "不明"}
                    </p>
                  </div>
                  {m.facility ? (
                    <HxBadge tone={verificationOf(m.facility).tone}>
                      {verificationOf(m.facility).label}
                    </HxBadge>
                  ) : null}
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <HxButton
                    size="sm"
                    variant={isSelected ? "secondary" : "primary"}
                    loading={busyId === m.membershipId}
                    disabled={!selectable || (busyId !== null && busyId !== m.membershipId)}
                    onClick={() => void select(m)}
                  >
                    {isSelected ? "この施設で続ける" : "この施設を選択"}
                  </HxButton>
                  {isSelected ? (
                    <span className="text-hx-caption font-semibold text-hx-success">
                      選択中の施設です
                    </span>
                  ) : !selectable ? (
                    <span className="text-hx-caption text-hx-text-subtle">
                      施設情報を取得できないため選択できません
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
