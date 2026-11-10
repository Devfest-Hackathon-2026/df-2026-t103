import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import {
  getFirestore,
  type Firestore,
  type ReadWriteTransactionOptions,
  type Transaction,
} from "firebase-admin/firestore";
import type { AppConfig } from "../../src/config.js";
import type { AuthAdmin } from "../../src/deps.js";
import type { FirestoreLike } from "../../src/repos/helpers.js";
import { makeTestDeps, type TestDeps } from "./deps.js";

/**
 * Firebase エミュレータ結合テスト用の deps ファクトリ（Issue #25）。
 * db に本物の Admin SDK Firestore、authAdmin に本物の Admin SDK Auth を注入し、
 * MemoryFirestore/fake では検証できないトランザクション・serverTimestamp・
 * Auth エラー（uid/email-already-exists）の実挙動を確認する。
 *
 * 接続先は必ずループバックのエミュレータに限定する。未設定・リモート宛ての
 * 環境変数は例外にして、実 Firebase プロジェクトへの暗黙接続を防止する。
 */

export const EMULATOR_PROJECT_ID = "demo-mmr-dev";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

function emulatorHostAndPort(envVar: string): { host: string; port: number } {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(
      `${envVar} が未設定です。エミュレータ結合テストは ` +
        `firebase emulators:exec 経由（CI）か compose ポート指定 ` +
        `（npm run test:emulator:compose）で実行してください。`,
    );
  }
  const withoutScheme = raw.replace(/^https?:\/\//, "");
  const sep = withoutScheme.lastIndexOf(":");
  let host = sep === -1 ? withoutScheme : withoutScheme.slice(0, sep);
  const port = Number(withoutScheme.slice(sep + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${envVar} の形式が不正です: ${raw}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `${envVar} はループバックのエミュレータのみ許可します: ${raw}`,
    );
  }
  // 0.0.0.0 は bind アドレスであり接続先にはならないため正規化する。
  // IPv6 リテラルも URL 組立てを単純化するため IPv4 ループバックへ寄せる。
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") {
    host = "127.0.0.1";
  }
  return { host, port };
}

interface EmulatorHandles {
  app: App;
  firestore: Firestore;
  auth: Auth;
}

let cached: EmulatorHandles | undefined;

/**
 * エミュレータ接続の Admin SDK ハンドル。projectId は demo- プレフィックス
 * 固定（demo プロジェクトは非エミュレータ接続が成立しない設計）で、
 * 呼出前に *_EMULATOR_HOST がループバックを指すことを必ず検証する。
 */
export function emulatorAdmin(): EmulatorHandles {
  emulatorHostAndPort("FIRESTORE_EMULATOR_HOST");
  if (!EMULATOR_PROJECT_ID.startsWith("demo-")) {
    throw new Error("emulator project must use a demo- prefix");
  }
  if (!cached) {
    const app =
      getApps().length > 0
        ? getApps()[0]!
        : initializeApp({ projectId: EMULATOR_PROJECT_ID });
    // 既存 default app が別プロジェクトなら誤った接続先になるため拒否する
    if (app.options.projectId !== EMULATOR_PROJECT_ID) {
      throw new Error(
        `default admin app の projectId が ${EMULATOR_PROJECT_ID} ではありません: ` +
          `${app.options.projectId}`,
      );
    }
    cached = { app, firestore: getFirestore(app), auth: getAuth(app) };
  }
  return cached;
}

async function emulatorDeleteAll(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`emulator reset failed: ${res.status} ${path}`);
  }
}

/** Firestore エミュレータの全ドキュメントを削除する（テスト間隔離）。 */
export async function clearEmulatorFirestore(): Promise<void> {
  const { host, port } = emulatorHostAndPort("FIRESTORE_EMULATOR_HOST");
  await emulatorDeleteAll(
    `http://${host}:${port}/emulator/v1/projects/${EMULATOR_PROJECT_ID}` +
      `/databases/(default)/documents`,
  );
}

/** Auth エミュレータの全ユーザーを削除する（テスト間隔離）。 */
export async function clearEmulatorAuth(): Promise<void> {
  const { host, port } = emulatorHostAndPort("FIREBASE_AUTH_EMULATOR_HOST");
  await emulatorDeleteAll(
    `http://${host}:${port}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`,
  );
}

/**
 * 実 Firestore に委譲しつつ runTransaction だけ回数指定で失敗させられる
 * ラッパ。Auth↔Firestore の部分失敗（registrationOperations 修復）を
 * 本物のトランザクション境界で再現するために使う。
 */
export class FlakyFirestore implements FirestoreLike {
  /** 次回以降の runTransaction を指定回数だけ失敗させる。 */
  failNextTransactions = 0;

  constructor(private readonly inner: Firestore) {}

  doc(path: string) {
    return this.inner.doc(path);
  }
  collection(path: string) {
    return this.inner.collection(path);
  }
  collectionGroup(collectionId: string) {
    return this.inner.collectionGroup(collectionId);
  }
  batch() {
    return this.inner.batch();
  }
  runTransaction<T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
    transactionOptions?: ReadWriteTransactionOptions,
  ): Promise<T> {
    if (this.failNextTransactions > 0) {
      this.failNextTransactions -= 1;
      return Promise.reject(new Error("injected firestore failure"));
    }
    return this.inner.runTransaction(updateFunction, transactionOptions);
  }
}

type AuthAdminMethod =
  | "createUser"
  | "updateUser"
  | "getUser"
  | "getUserByEmail"
  | "deleteUser"
  | "revokeRefreshTokens";

/**
 * 実 Auth エミュレータに委譲しつつ、指定した管理操作だけを回数指定で
 * 失敗させられるラッパ（Auth 側障害の失敗注入用）。
 */
export class FlakyAuthAdmin implements AuthAdmin {
  failNext = new Map<AuthAdminMethod, number>();

  constructor(private readonly auth: Auth) {}

  private gate(method: AuthAdminMethod): void {
    const remaining = this.failNext.get(method) ?? 0;
    if (remaining > 0) {
      this.failNext.set(method, remaining - 1);
      throw new Error(`injected auth ${method} failure`);
    }
  }

  createUser(props: {
    uid: string;
    email: string;
    password: string;
    emailVerified: boolean;
    disabled: boolean;
  }) {
    this.gate("createUser");
    return this.auth.createUser(props);
  }
  updateUser(
    uid: string,
    props: { disabled?: boolean; emailVerified?: boolean },
  ) {
    this.gate("updateUser");
    return this.auth.updateUser(uid, props);
  }
  getUser(uid: string) {
    this.gate("getUser");
    return this.auth.getUser(uid);
  }
  getUserByEmail(email: string) {
    this.gate("getUserByEmail");
    return this.auth.getUserByEmail(email);
  }
  deleteUser(uid: string) {
    this.gate("deleteUser");
    return this.auth.deleteUser(uid);
  }
  revokeRefreshTokens(uid: string) {
    this.gate("revokeRefreshTokens");
    return this.auth.revokeRefreshTokens(uid);
  }
}

export interface EmulatorDeps extends TestDeps {
  /** 注入した本物の Admin SDK Firestore（検証用アクセスにも使用）。 */
  firestore: Firestore;
  /** deps.db に注入されている失敗注入ラッパ。 */
  flakyDb: FlakyFirestore;
  /** realAuth 指定時の Auth エミュレータ失敗注入ラッパ。 */
  flakyAuthAdmin?: FlakyAuthAdmin;
  /** realAuth 指定時の本物の Admin SDK Auth（ユーザー実在検証用）。 */
  emulatorAuth?: Auth;
  /**
   * 継承元の memDb は接続されていない（deps.db は実 Firestore）。
   * memDb.raw()/listAllPaths() 等で検査しても何も見えないため使用しない。
   */
  memDb: TestDeps["memDb"];
}

/**
 * エミュレータ結合用の Deps。
 * db は本物の Firestore（FlakyFirestore 経由）、それ以外は既存 fake を維持。
 * realAuth=true で authAdmin が本物の Auth エミュレータになる
 * （authAdmin.createUser 等が実際にユーザーを作る）。
 */
export function makeEmulatorDeps(opts: {
  config?: Partial<AppConfig>;
  realAuth?: boolean;
} = {}): EmulatorDeps {
  const { firestore, auth } = emulatorAdmin();
  const flakyDb = new FlakyFirestore(firestore);
  const deps = makeTestDeps(opts.config ?? {}) as EmulatorDeps;
  deps.db = flakyDb;
  deps.firestore = firestore;
  deps.flakyDb = flakyDb;
  if (opts.realAuth) {
    emulatorHostAndPort("FIREBASE_AUTH_EMULATOR_HOST");
    const flakyAuthAdmin = new FlakyAuthAdmin(auth);
    deps.authAdmin = flakyAuthAdmin;
    deps.flakyAuthAdmin = flakyAuthAdmin;
    deps.emulatorAuth = auth;
  }
  return deps;
}
