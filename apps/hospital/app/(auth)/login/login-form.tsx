"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import {
  getMultiFactorResolver,
  multiFactor,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
  type TotpSecret,
} from "firebase/auth";
import { HxButton } from "../../../components/design-system/hx-button";
import { HxField, hxInputClass } from "../../../components/design-system/hx-field";
import { HxIcon } from "../../../components/design-system/hx-icon";
import { firebaseClient } from "../../../lib/firebase-client";
import { establishSession } from "../../../lib/staff-session";

type Step =
  | { kind: "credentials" }
  | { kind: "mfa"; resolver: MultiFactorResolver; hintUid: string }
  | { kind: "enroll"; secret: TotpSecret };

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const GENERIC_AUTH_ERROR = "メールアドレスまたはパスワードが正しくありません。";

function errorMessage(error: unknown): string {
  const code = (error as { code?: string }).code ?? "";
  if (code === "auth/too-many-requests" || code === "auth/too-many-requests-try-later") {
    return "試行回数が多すぎます。時間をおいて再試行してください。";
  }
  if (code === "auth/network-request-failed") {
    return "通信できませんでした。接続状態を確認してください。";
  }
  return GENERIC_AUTH_ERROR;
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [busy, setBusy] = useState(false);
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [message, setMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function finish() {
    // セッションCookieの確立が失敗したらサインイン済みでも進ませない（資格情報を残さない）
    const ok = await establishSession();
    if (ok) {
      router.replace(next);
      router.refresh();
      return;
    }
    await signOut(firebaseClient().auth).catch(() => undefined);
    setMessage("セッションを確立できませんでした。時間をおいて再試行してください。");
  }

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setBusy(true);
    setMessage("");
    try {
      const cred = await signInWithEmailAndPassword(firebaseClient().auth, email, password);
      if (multiFactor(cred.user).enrolledFactors.length === 0) {
        // 職員はMFA必須（NFR-05）。未登録ならこの場でTOTP登録を求める。
        const session = await multiFactor(cred.user).getSession();
        const secret = await TotpMultiFactorGenerator.generateSecret(session);
        setStep({ kind: "enroll", secret });
      } else {
        await finish();
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "auth/multi-factor-auth-required") {
        const resolver = getMultiFactorResolver(firebaseClient().auth, error as MultiFactorError);
        const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
        if (hint) setStep({ kind: "mfa", resolver, hintUid: hint.uid });
        else setMessage("このMFA方式は未対応です。管理者に確認してください。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== "mfa") return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    setBusy(true);
    setMessage("");
    try {
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(step.hintUid, code);
      await step.resolver.resolveSignIn(assertion);
      await finish();
    } catch {
      setMessage("認証コードが正しくありません。期限切れの場合はログインからやり直してください。");
    } finally {
      setBusy(false);
    }
  }

  async function submitEnroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== "enroll") return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    const user = firebaseClient().auth.currentUser;
    if (!user) {
      setMessage("ログイン状態を確認できません。もう一度ログインしてください。");
      setStep({ kind: "credentials" });
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(step.secret, code);
      await multiFactor(user).enroll(assertion, "認証アプリ");
      await finish();
    } catch {
      setMessage("登録用の認証コードが正しくありません。アプリの時刻を確認して再入力してください。");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    const input = document.getElementById("hx-login-email") as HTMLInputElement | null;
    const email = input?.value.trim();
    if (!email) {
      setMessage("再設定メールの送信にはメールアドレスの入力が必要です。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await sendPasswordResetEmail(firebaseClient().auth, email);
      // アカウント存在可否を開示しない（H-001）
      setResetSent(true);
    } catch {
      setResetSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function backToCredentials() {
    setMessage("");
    await signOut(firebaseClient().auth).catch(() => undefined);
    setStep({ kind: "credentials" });
  }

  if (step.kind === "mfa") {
    return (
      <form method="post" onSubmit={submitMfa} className="space-y-5 rounded-md border border-hx-border bg-hx-surface p-6">
        <div className="space-y-1">
          <h2 className="text-hx-section-title font-semibold">多要素認証</h2>
          <p className="text-hx-body text-hx-text-subtle">
            認証アプリに表示されている6桁のコードを入力してください。
          </p>
        </div>
        <HxField label="認証コード" required>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            className={hxInputClass}
            data-autofocus
          />
        </HxField>
        {message ? <p role="alert" className="text-hx-caption font-semibold text-hx-danger">{message}</p> : null}
        <div className="flex items-center justify-between gap-3">
          <HxButton variant="subtle" onClick={() => void backToCredentials()} disabled={busy}>
            ログインに戻る
          </HxButton>
          <HxButton type="submit" disabled={!ready} loading={busy}>確認する</HxButton>
        </div>
      </form>
    );
  }

  if (step.kind === "enroll") {
    return (
      <form method="post" onSubmit={submitEnroll} className="space-y-5 rounded-md border border-hx-border bg-hx-surface p-6">
        <div className="space-y-1">
          <h2 className="text-hx-section-title font-semibold">多要素認証の設定</h2>
          <p className="text-hx-body text-hx-text-subtle">
            職員アカウントには多要素認証が必要です。認証アプリに次のキーを登録し、
            表示される6桁のコードを入力してください。
          </p>
        </div>
        <div className="space-y-2 rounded-sm bg-hx-surface-subtle p-3 text-hx-caption">
          <p className="break-all font-mono">{step.secret.generateQrCodeUrl("もしもし問診 医療機関ポータル")}</p>
          <p>
            手動キー：<span className="font-mono font-semibold">{step.secret.secretKey}</span>
          </p>
        </div>
        <HxField label="認証コード" required description="登録したアプリに表示される6桁のコード">
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            className={hxInputClass}
            data-autofocus
          />
        </HxField>
        {message ? <p role="alert" className="text-hx-caption font-semibold text-hx-danger">{message}</p> : null}
        <div className="flex items-center justify-between gap-3">
          <HxButton variant="subtle" onClick={() => void backToCredentials()} disabled={busy}>
            ログインに戻る
          </HxButton>
          <HxButton type="submit" disabled={!ready} loading={busy}>登録する</HxButton>
        </div>
      </form>
    );
  }

  return (
    <form method="post" onSubmit={submitCredentials} className="space-y-5 rounded-md border border-hx-border bg-hx-surface p-6">
      <HxField label="メールアドレス" required>
        <input
          id="hx-login-email"
          name="email"
          type="email"
          autoComplete="username"
          className={hxInputClass}
          data-autofocus
        />
      </HxField>
      <div className="relative">
        <HxField label="パスワード" required>
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            className={`${hxInputClass} pr-16`}
          />
        </HxField>
        <button
          type="button"
          aria-pressed={showPassword}
          onClick={() => setShowPassword((v) => !v)}
          className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-sm px-2 py-1 text-hx-caption font-semibold text-hx-primary"
        >
          <HxIcon name={showPassword ? "x" : "search"} size={14} />
          {showPassword ? "隠す" : "表示"}
        </button>
      </div>
      {message ? <p role="alert" className="text-hx-caption font-semibold text-hx-danger">{message}</p> : null}
      {resetSent ? (
        <p role="status" className="text-hx-caption text-hx-text-subtle">
          登録済みのメールアドレスであれば、再設定用のメールを送信しました。
        </p>
      ) : null}
      <div className="space-y-3">
        <HxButton type="submit" block disabled={!ready} loading={busy}>ログイン</HxButton>
        <button
          type="button"
          onClick={() => void resetPassword()}
          disabled={busy || !ready}
          className="w-full text-center text-hx-caption font-semibold text-hx-primary underline-offset-2 hover:underline"
        >
          パスワードをお忘れですか
        </button>
      </div>
    </form>
  );
}
