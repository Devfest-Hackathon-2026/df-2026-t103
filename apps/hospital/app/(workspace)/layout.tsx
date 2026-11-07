import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession, sessionApiFetch } from "../../lib/session";
import { PATHNAME_HEADER } from "../../lib/session-shared";
import type { MembershipsResponse } from "../../lib/memberships";
import { HxErrorPanel } from "../../components/design-system/hx-feedback";
import { WorkspaceShell } from "./workspace-shell";

function UpstreamError({
  title,
  description,
  retryHref,
}: {
  title: string;
  description: string;
  retryHref: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-3">
        <HxErrorPanel title={title} description={description} />
        <Link
          href={retryHref}
          className="inline-flex h-9 items-center rounded-sm border border-hx-border bg-hx-surface px-4 text-hx-body font-semibold text-hx-text hover:bg-hx-row-hover"
        >
          再試行する
        </Link>
      </div>
    </main>
  );
}

/**
 * 認証後ページ共通ガード（H-001 以降の全業務画面）。
 * セッション Cookie がなければ H-001 へ。Cookie があっても API が
 * 401/403 を返せば Cookie を消してからログインへ戻す（失効ループ防止）。
 * 5xx や接続失敗はログアウトさせず、再試行可能なエラー画面を出す。
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) {
    // 無効・空値などの残留Cookieも消してからログインへ戻す
    redirect("/api/session/logout");
  }

  // RSC データ要求に付く _rsc パラメータだけを落として元URLを復元する
  const rawPath = (await headers()).get(PATHNAME_HEADER) ?? "/facilities";
  const retryParams = new URLSearchParams(rawPath.split("?")[1] ?? "");
  retryParams.delete("_rsc");
  const query = retryParams.toString();
  const currentPath = `${rawPath.split("?")[0]}${query ? `?${query}` : ""}`;

  const upstream = await sessionApiFetch(session, "/me/facility-memberships").catch(
    () => null,
  );

  if (!upstream) {
    return (
      <UpstreamError
        title="接続できませんでした"
        description="ネットワークまたはサービスの障害です。時間をおいて再試行してください。"
        retryHref={currentPath}
      />
    );
  }
  if (upstream.status === 401 || upstream.status === 403) {
    // RSC では Cookie を消せないため、消去用 Route Handler 経由で戻す
    redirect(`/api/session/logout?next=${encodeURIComponent(currentPath)}`);
  }
  if (!upstream.ok) {
    return (
      <UpstreamError
        title="読み込みに失敗しました"
        description="サーバで問題が発生しています。時間をおいて再試行してください。"
        retryHref={currentPath}
      />
    );
  }

  let memberships: MembershipsResponse;
  try {
    const data: unknown = await upstream.json();
    if (!data || typeof data !== "object" || !Array.isArray((data as MembershipsResponse).items)) {
      throw new Error("unexpected shape");
    }
    memberships = data as MembershipsResponse;
  } catch {
    return (
      <UpstreamError
        title="読み込みに失敗しました"
        description="サーバ応答を処理できませんでした。時間をおいて再試行してください。"
        retryHref={currentPath}
      />
    );
  }
  return <WorkspaceShell memberships={memberships.items}>{children}</WorkspaceShell>;
}
