"use client";

import { HxBadge } from "../../../components/design-system/hx-status-badge";
import { HxEmptyState } from "../../../components/design-system/hx-feedback";
import { HxIcon } from "../../../components/design-system/hx-icon";
import { HxPageHeader } from "../../../components/design-system/hx-page-header";
import { STAFF_ROLE_LABEL } from "../../../lib/memberships";
import { useMemberships } from "../workspace-shell";

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

export function FacilitiesClient() {
  const memberships = useMemberships();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <HxPageHeader
        title="所属施設の確認"
        description="あなたが所属する施設と役割です。施設を選択して業務を開始する画面は現在実装中です。"
      />
      {memberships.length === 0 ? (
        <HxEmptyState
          icon="building"
          title="所属施設がありません"
          description="施設の管理者に職員招待を依頼してください。"
        />
      ) : (
        <ul className="space-y-3">
          {memberships.map((m) => (
            <li
              key={m.membershipId}
              className="flex items-start justify-between gap-4 rounded-md border border-hx-border bg-hx-surface p-4"
            >
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
