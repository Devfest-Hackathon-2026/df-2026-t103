"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { onIdTokenChanged } from "firebase/auth";
import { HxBadge } from "../../../components/design-system/hx-status-badge";
import { HxDataTable, HxTd, HxTh, HxTr } from "../../../components/design-system/hx-data-table";
import { HxButton } from "../../../components/design-system/hx-button";
import { HxConfirmActionDialog, HxDialog } from "../../../components/design-system/hx-dialog";
import { HxEmptyState, HxErrorPanel, type HxErrorKind } from "../../../components/design-system/hx-feedback";
import { HxField, hxInputClass } from "../../../components/design-system/hx-field";
import { HxPageHeader } from "../../../components/design-system/hx-page-header";
import { HxSkeletonRows } from "../../../components/design-system/hx-skeleton";
import { useSelectedFacility } from "../workspace-shell";
import { firebaseClient } from "../../../lib/firebase-client";
import { STAFF_ROLE_LABEL, type StaffRole } from "../../../lib/memberships";
import { hxApi, HxApiError } from "../../../lib/hx-api";

interface StaffMember {
  membershipId: string;
  userUid: string;
  email: string | null;
  role: StaffRole;
  status: "active" | "revoked";
  createdAt: string | null;
  revokedAt: string | null;
}

interface StaffInvitation {
  invitationId: string;
  email: string;
  role: StaffRole;
  createdAt: string | null;
}

interface StaffListResponse {
  members: StaffMember[];
  invitations: StaffInvitation[];
}

const ROLE_OPTIONS: StaffRole[] = ["facility_staff", "facility_clinician", "facility_admin"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
}

function errorKind(err: unknown): HxErrorKind {
  if (!(err instanceof HxApiError)) return "error";
  if (err.status === 401) return "session";
  if (err.status === 403) return "forbidden";
  if (err.status === 0) return "offline";
  return "error";
}

export function StaffClient() {
  const selected = useSelectedFacility();
  const facilityId = selected?.facilityId ?? null;
  const isAdmin = selected?.role === "facility_admin";
  // 自分自身のメンバーシップ行は権限変更・停止不可（API側でも拒否される）
  // 購読で取得するため SSR・初回ハイドレーションは null で一致し、Auth 復元後に更新される
  const [currentUid, setCurrentUid] = useState<string | null>(null);
  useEffect(() => {
    const client = firebaseClient();
    return onIdTokenChanged(client.auth, (user) => setCurrentUid(user?.uid ?? null));
  }, []);

  // facilityId とセットで保持し、施設切替直後に前施設の一覧が残らないようにする
  const [data, setData] = useState<{ facilityId: string; res: StaffListResponse } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ kind: HxErrorKind; message: string } | null>(null);
  const reqSeqRef = useRef(0);

  // 現在の施設のデータだけを表示対象にする（切替直後の前施設データを描画しない）
  const list = data && data.facilityId === facilityId ? data.res : null;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<StaffRole>("facility_staff");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<
    | { kind: "revoke" | "reactivate"; member: StaffMember }
    | { kind: "role"; member: StaffMember; role: StaffRole }
    | null
  >(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, StaffRole>>({});

  const load = useCallback(() => {
    if (!facilityId || !isAdmin) return Promise.resolve();
    const reqId = ++reqSeqRef.current;
    const url = `hospitals/${encodeURIComponent(facilityId)}/staff`;
    return Promise.resolve()
      .then(() => {
        if (reqId !== reqSeqRef.current) return undefined;
        setLoading(true);
        setError(null);
        return hxApi<StaffListResponse>(url);
      })
      .then((res) => {
        if (!res || reqId !== reqSeqRef.current) return;
        setData({ facilityId, res });
        setRoleDrafts({});
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

  async function submitInvite(event: FormEvent) {
    event.preventDefault();
    if (!facilityId || inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      await hxApi(`hospitals/${encodeURIComponent(facilityId)}/staff-invitations`, {
        method: "POST",
        body: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("facility_staff");
      await load();
    } catch (err) {
      if (err instanceof HxApiError && err.code === "REAUTH_REQUIRED") {
        // 直近認証の期限切れ。再試行しても成功しないため再ログインへ誘導する
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/api/session/logout");
        return;
      }
      setInviteError(
        err instanceof HxApiError && err.status === 409
          ? "このメールアドレスへの招待はすでに保留中です。"
          : err instanceof HxApiError
            ? err.message
            : "招待の作成に失敗しました。",
      );
    } finally {
      setInviteBusy(false);
    }
  }

  async function runPendingAction() {
    if (!facilityId || !pendingAction || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const { member } = pendingAction;
    let body: { role: StaffRole } | { status: "active" | "revoked" };
    if (pendingAction.kind === "role") {
      body = { role: pendingAction.role };
    } else {
      body = { status: pendingAction.kind === "revoke" ? "revoked" : "active" };
    }
    try {
      await hxApi(
        `hospitals/${encodeURIComponent(facilityId)}/memberships/${encodeURIComponent(member.membershipId)}`,
        { method: "PATCH", body },
      );
      setPendingAction(null);
      await load();
    } catch (err) {
      setPendingAction(null);
      if (err instanceof HxApiError && err.code === "REAUTH_REQUIRED") {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/api/session/logout");
        return;
      }
      setActionError(err instanceof HxApiError ? err.message : "変更に失敗しました。もう一度お試しください。");
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
          description="職員管理を行うには、まず業務を行う施設を選択してください。"
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
        <HxPageHeader title="職員管理" />
        <HxErrorPanel
          kind="forbidden"
          description="職員の招待・権限変更・停止は施設管理者（facility_admin）のみが行えます。"
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <HxPageHeader
        title="職員管理"
        description={`${selected.facility?.displayName ?? "選択中の施設"}の職員と招待状況です。`}
      />

      <div className="flex justify-end">
        <HxButton
          onClick={() => {
            setInviteError(null);
            setInviteOpen(true);
          }}
        >
          職員を招待する
        </HxButton>
      </div>

      {actionError ? (
        <HxErrorPanel
          kind="error"
          title="変更を適用できませんでした"
          description={actionError}
          actionLabel="一覧を再読み込み"
          onAction={() => void load()}
        />
      ) : null}

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
      ) : list === null && loading ? (
        <HxDataTable caption="職員一覧を読み込み中" busy>
          <thead>
            <tr>
              <HxTh>メールアドレス</HxTh>
              <HxTh>役割</HxTh>
              <HxTh>状態</HxTh>
              <HxTh>操作</HxTh>
            </tr>
          </thead>
          <tbody>
            <HxSkeletonRows rows={4} columns={4} />
          </tbody>
        </HxDataTable>
      ) : list === null ? null : (
        <>
          <section aria-labelledby="members-heading" className="space-y-3">
            <h2 id="members-heading" className="text-hx-section-title font-semibold">
              所属職員（{list.members.length}名）
            </h2>
            {list.members.length === 0 ? (
              <HxEmptyState icon="users" title="所属職員がいません" description="職員を招待してください。" />
            ) : (
              <HxDataTable caption="所属職員一覧" busy={loading}>
                <thead>
                  <tr>
                    <HxTh>メールアドレス</HxTh>
                    <HxTh className="w-52">役割</HxTh>
                    <HxTh className="w-28">状態</HxTh>
                    <HxTh className="w-56">操作</HxTh>
                  </tr>
                </thead>
                <tbody>
                  {list.members.map((m) => {
                    const draft = roleDrafts[m.membershipId] ?? m.role;
                    const isSelf = currentUid !== null && currentUid === m.userUid;
                    const canEdit = m.status === "active" && !isSelf;
                    return (
                      <HxTr key={m.membershipId}>
                        <HxTd>
                          {m.email ?? <span className="text-hx-text-subtle">（メール未登録）</span>}
                          {isSelf ? <span className="ml-2 text-hx-caption text-hx-text-subtle">（あなた）</span> : null}
                        </HxTd>
                        <HxTd>
                          <select
                            aria-label={`${m.email ?? m.userUid} の役割`}
                            value={draft}
                            disabled={!canEdit}
                            onChange={(e) =>
                              setRoleDrafts((d) => ({ ...d, [m.membershipId]: e.target.value as StaffRole }))
                            }
                            className={hxInputClass}
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {STAFF_ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        </HxTd>
                        <HxTd>
                          {m.status === "active" ? (
                            <HxBadge tone="success">有効</HxBadge>
                          ) : (
                            <HxBadge tone="neutral">停止中</HxBadge>
                          )}
                        </HxTd>
                        <HxTd>
                          <div className="flex flex-wrap gap-2">
                            {canEdit && draft !== m.role ? (
                              <HxButton
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  setPendingAction({ kind: "role", member: m, role: draft })
                                }
                              >
                                役割を変更
                              </HxButton>
                            ) : null}
                            {m.status === "active" && !isSelf ? (
                              <HxButton
                                size="sm"
                                variant="danger"
                                onClick={() => setPendingAction({ kind: "revoke", member: m })}
                              >
                                停止する
                              </HxButton>
                            ) : null}
                            {m.status === "revoked" ? (
                              <HxButton
                                size="sm"
                                variant="secondary"
                                onClick={() => setPendingAction({ kind: "reactivate", member: m })}
                              >
                                再有効化
                              </HxButton>
                            ) : null}
                          </div>
                        </HxTd>
                      </HxTr>
                    );
                  })}
                </tbody>
              </HxDataTable>
            )}
          </section>

          <section aria-labelledby="invitations-heading" className="space-y-3">
            <h2 id="invitations-heading" className="text-hx-section-title font-semibold">
              保留中の招待（{list.invitations.length}件）
            </h2>
            {list.invitations.length === 0 ? (
              <p className="text-hx-body text-hx-text-subtle">保留中の招待はありません。</p>
            ) : (
              <HxDataTable caption="保留中の招待一覧">
                <thead>
                  <tr>
                    <HxTh>メールアドレス</HxTh>
                    <HxTh>招待する役割</HxTh>
                    <HxTh>招待日</HxTh>
                  </tr>
                </thead>
                <tbody>
                  {list.invitations.map((inv) => (
                    <HxTr key={inv.invitationId}>
                      <HxTd>{inv.email}</HxTd>
                      <HxTd>{STAFF_ROLE_LABEL[inv.role]}</HxTd>
                      <HxTd numeric>{formatDate(inv.createdAt)}</HxTd>
                    </HxTr>
                  ))}
                </tbody>
              </HxDataTable>
            )}
          </section>
        </>
      )}

      <HxDialog
        open={inviteOpen}
        onClose={
          inviteBusy
            ? () => undefined
            : () => {
                setInviteError(null);
                setInviteOpen(false);
              }
        }
        title="職員を招待する"
        description="入力したメールアドレスへ招待を作成します。招待された職員が登録すると、この施設のメンバーとして追加されます。"
        footer={
          <>
            <HxButton
              variant="secondary"
              disabled={inviteBusy}
              onClick={() => {
                setInviteError(null);
                setInviteOpen(false);
              }}
            >
              キャンセル
            </HxButton>
            <HxButton type="submit" form="invite-form" loading={inviteBusy}>
              招待を送信
            </HxButton>
          </>
        }
      >
        <form id="invite-form" onSubmit={submitInvite} className="space-y-4">
          <HxField label="メールアドレス" required error={inviteError ?? undefined}>
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className={hxInputClass}
              autoComplete="off"
              data-autofocus
            />
          </HxField>
          <HxField label="役割" required>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as StaffRole)}
              className={hxInputClass}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {STAFF_ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </HxField>
        </form>
      </HxDialog>

      <HxConfirmActionDialog
        open={pendingAction !== null}
        subject={pendingAction?.member.email ?? pendingAction?.member.userUid ?? ""}
        title={
          pendingAction?.kind === "revoke"
            ? "この職員を停止しますか？"
            : pendingAction?.kind === "reactivate"
              ? "この職員を再有効化しますか？"
              : "役割を変更しますか？"
        }
        description={
          pendingAction?.kind === "revoke"
            ? "停止すると、この職員はこの施設の問診票・職員管理へアクセスできなくなります。"
            : pendingAction?.kind === "reactivate"
              ? "再有効化すると、この職員は再びこの施設の業務にアクセスできるようになります。"
              : pendingAction?.kind === "role"
                ? `${STAFF_ROLE_LABEL[pendingAction.member.role]} から ${STAFF_ROLE_LABEL[pendingAction.role]} に変更します。`
                : ""
        }
        confirmLabel={
          pendingAction?.kind === "revoke"
            ? "停止する"
            : pendingAction?.kind === "reactivate"
              ? "再有効化する"
              : "変更する"
        }
        tone={pendingAction?.kind === "revoke" ? "danger" : "primary"}
        busy={actionBusy}
        onConfirm={() => void runPendingAction()}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}
