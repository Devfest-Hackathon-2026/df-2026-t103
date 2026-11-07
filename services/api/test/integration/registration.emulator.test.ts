import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerEmail } from "../../src/services/registration.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import {
  clearEmulatorAuth,
  clearEmulatorFirestore,
  makeEmulatorDeps,
  type EmulatorDeps,
} from "../helpers/emulator.js";
import { buildTestApp, seedLegalDocuments } from "../helpers/app.js";

/**
 * API-041 メール登録のエミュレータ結合テスト（Issue #25 / E2E-001B）。
 * authAdmin に実 Auth エミュレータ、db に実 Firestore を使い、
 * uid/email-already-exists・部分失敗からの修復を実挙動で検証する。
 */

const validBody = {
  email: "emu-reg@example.com",
  password: "abcd1234",
  consents: {
    terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
    privacy_policy_ack: { accepted: true, documentVersion: "2026-11-01" },
    health_data_collection: { accepted: true, documentVersion: "2026-11-01" },
  },
  locale: "ja-JP",
};

async function seed(deps: EmulatorDeps): Promise<void> {
  await seedLegalDocuments(deps);
}

async function authUserCount(deps: EmulatorDeps): Promise<number> {
  return (await deps.emulatorAuth!.listUsers()).users.length;
}

describe("registerEmail / Auth・Firestore エミュレータ結合", () => {
  let deps: EmulatorDeps;

  beforeEach(async () => {
    await clearEmulatorFirestore();
    await clearEmulatorAuth();
    deps = makeEmulatorDeps({ realAuth: true });
    await seed(deps);
  });

  afterEach(async () => {
    await clearEmulatorFirestore();
    await clearEmulatorAuth();
  });

  it("登録成功: 実Authユーザーがdisabled→enabledになり account+consents+台帳が実FSに残る", async () => {
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "emu-key-1",
      requestId: "req-1",
    });
    expect(r.registrationStatus).toBe("created");

    // 実 Auth エミュレータ上でユーザーが有効
    const users = await deps.emulatorAuth!.listUsers();
    expect(users.users).toHaveLength(1);
    const uid = users.users[0]!.uid;
    expect(users.users[0]!.disabled).toBe(false);
    expect(users.users[0]!.email).toBe(validBody.email);

    // 実 Firestore 上の副作用
    const account = await deps.firestore.doc(`accounts/${uid}`).get();
    expect(account.exists).toBe(true);
    expect(account.data()!.accountStatus).toBe("onboarding_pending");
    const consents = await deps.firestore
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(consents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    const ops = await deps.firestore.collection("registrationOperations").get();
    expect(ops.size).toBe(1);
    expect(ops.docs[0]!.data().status).toBe("enabled");
  });

  it("同一キー再送は Auth ユーザーを増やさず成功を返す（冪等再試行）", async () => {
    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "emu-key-1",
      requestId: "req-1",
    });
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "emu-key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(await authUserCount(deps)).toBe(1);
    const accounts = await deps.firestore.collection("accounts").get();
    expect(accounts.size).toBe(1);
  });

  it("同一キー+異なる本文は 409、他人の既存Authは上書きしない（SEC-17）", async () => {
    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "emu-key-1",
      requestId: "req-1",
    });
    await expect(
      registerEmail(deps, {
        body: { ...validBody, email: "other@example.com" },
        idempotencyKey: "emu-key-1",
        requestId: "req-2",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await authUserCount(deps)).toBe(1);
  });

  it("必須同意欠落は 400 で Auth ユーザーを作らない（同意ゲート・E2E-001B）", async () => {
    const { terms_of_service: _t, ...consents } = validBody.consents;
    await expect(
      registerEmail(deps, {
        body: { ...validBody, consents },
        idempotencyKey: "emu-key-1",
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await authUserCount(deps)).toBe(0);
  });

  it("旧版同意は 412 で Auth ユーザーを作らない（同意ゲート・SEC-18）", async () => {
    await expect(
      registerEmail(deps, {
        body: {
          ...validBody,
          consents: {
            ...validBody.consents,
            terms_of_service: {
              accepted: true,
              documentVersion: "2020-01-01",
            },
          },
        },
        idempotencyKey: "emu-key-1",
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ statusCode: 412 });
    expect(await authUserCount(deps)).toBe(0);
  });

  it("Auth作成後のFirestore tx失敗→台帳failed→同一キーで修復収束（失敗注入）", async () => {
    // 1回目: Firestore トランザクションのみ失敗させる（Auth作成は成功する）
    deps.flakyDb.failNextTransactions = 1;
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "emu-key-1",
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    // 台帳は failed、実Authユーザーは disabled のまま残る
    const ops = await deps.firestore.collection("registrationOperations").get();
    expect(ops.size).toBe(1);
    expect(ops.docs[0]!.data().status).toBe("failed");
    const users = await deps.emulatorAuth!.listUsers();
    expect(users.users).toHaveLength(1);
    const uid = users.users[0]!.uid;
    expect(users.users[0]!.disabled).toBe(true);
    expect((await deps.firestore.doc(`accounts/${uid}`).get()).exists).toBe(
      false,
    );

    // 2回目: 復旧。createUser が実 Auth の uid-already-exists を踏んで再開する
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "emu-key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(
      (await deps.emulatorAuth!.getUser(uid)).disabled,
    ).toBe(false);
    expect((await deps.firestore.doc(`accounts/${uid}`).get()).exists).toBe(
      true,
    );
    const opsAfter = await deps.firestore
      .collection("registrationOperations")
      .get();
    expect(opsAfter.size).toBe(1);
    expect(opsAfter.docs[0]!.data().status).toBe("enabled");
  });

  it("Firestore tx後のAuth有効化失敗→台帳はconsents_committedで保護→再開で収束・同意書は二重発行しない（失敗注入）", async () => {
    // tx は成功させ、Auth updateUser のみ失敗させる
    deps.flakyAuthAdmin!.failNext.set("updateUser", 1);
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "emu-key-1",
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    const ops = await deps.firestore.collection("registrationOperations").get();
    // failed への巻き戻しはされず、コミット済み checkpoint が保護される
    expect(ops.docs[0]!.data().status).toBe("consents_committed");
    const users = await deps.emulatorAuth!.listUsers();
    const uid = users.users[0]!.uid;
    // account+consents は commit 済みだが Auth は disabled のまま
    expect(users.users[0]!.disabled).toBe(true);
    expect((await deps.firestore.doc(`accounts/${uid}`).get()).exists).toBe(
      true,
    );

    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "emu-key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect((await deps.emulatorAuth!.getUser(uid)).disabled).toBe(false);
    // 同意書が二重発行されていない
    const consents = await deps.firestore
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(consents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
  });

  it("別UIDのdisabled Authユーザー（孤児候補）は account 有無によらず削除せず 409", async () => {
    // #170 で意図的に強化: disabled・account無しでも「他UID所有」を削除して
    // 回収はしない（並走する別キー登録のユーザー誤削除を防ぐ）。
    // 同一UID経路（同じ登録キーの再試行）は別テストで修復を確認済み。
    // ※ 別キー再試行が詰むケースは #208 でフォローアップ。
    const orphan = await deps.emulatorAuth!.createUser({
      email: validBody.email,
      password: "old-password",
      emailVerified: false,
      disabled: true,
    });

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "emu-key-1",
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // 孤児候補は削除されず、新規Authユーザーも作られない
    expect((await deps.emulatorAuth!.getUser(orphan.uid)).disabled).toBe(true);
    const users = await deps.emulatorAuth!.listUsers();
    expect(users.users).toHaveLength(1);
  });

  it("有効な既存ユーザーのメールは 409 で孤児も削除しない（email-already-exists）", async () => {
    const existing = await deps.emulatorAuth!.createUser({
      email: validBody.email,
      password: "their-password",
      emailVerified: true,
      disabled: false,
    });

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "emu-key-1",
        requestId: "req-1",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // 既存ユーザーはそのまま残り、新たな account は作られない
    const kept = await deps.emulatorAuth!.getUser(existing.uid);
    expect(kept.disabled).toBe(false);
    const accounts = await deps.firestore.collection("accounts").get();
    expect(accounts.size).toBe(0);
  });
});

describe("POST /v1/auth/register / エミュレータ結合（HTTP層）", () => {
  let deps: EmulatorDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    await clearEmulatorFirestore();
    await clearEmulatorAuth();
    deps = makeEmulatorDeps({ realAuth: true });
    await seedLegalDocuments(deps);
    app = buildTestApp(deps);
  });

  afterEach(async () => {
    await app.close();
    await clearEmulatorFirestore();
    await clearEmulatorAuth();
  });

  it("同一キーの HTTP 再送は 201 を返し副作用は1件のみ（冪等）", async () => {
    const headers = { "idempotency-key": "http-key-1" };
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers,
      payload: validBody,
    });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers,
      payload: validBody,
    });
    expect(r2.statusCode).toBe(201);
    expect(await authUserCount(deps)).toBe(1);
  });

  it("レート制限: register は 5 req/min 超過で 429", async () => {
    // 既定 RateRules.register = 5/min。実FS経路でもリミッタが効くことを確認。
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        headers: { "idempotency-key": `rl-${i}` },
        payload: { ...validBody, email: `rl-${i}@example.com` },
      });
      expect(res.statusCode).toBe(201);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "idempotency-key": "rl-over" },
      payload: { ...validBody, email: "rl-over@example.com" },
    });
    expect(limited.statusCode).toBe(429);
  });

  it("未認証メールは登録できても emailVerified=false のまま", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "idempotency-key": "unverified-1" },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const users = await deps.emulatorAuth!.listUsers();
    expect(users.users[0]!.emailVerified).toBe(false);
  });
});
