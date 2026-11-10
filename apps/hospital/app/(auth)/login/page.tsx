import { redirect } from "next/navigation";
import { PortalHeader } from "../../../components/layout/portal-header";
import { readSession } from "../../../lib/session";
import { LoginForm } from "./login-form";

/** H-001 職員ログイン。セッション済みなら施設確認へ進める。 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await readSession()) redirect("/facilities");
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/facilities";

  return (
    <div className="min-h-screen">
      <PortalHeader />
      <main id="hx-main-content" className="flex justify-center px-4 py-12">
        <div className="w-full max-w-[420px] space-y-6">
          <div className="space-y-1 text-center">
            <h1 className="text-hx-page-title font-bold">職員ログイン</h1>
            <p className="text-hx-body text-hx-text-subtle">
              施設の職員アカウントでログインしてください。
            </p>
          </div>
          <LoginForm next={safeNext} />
        </div>
      </main>
    </div>
  );
}
