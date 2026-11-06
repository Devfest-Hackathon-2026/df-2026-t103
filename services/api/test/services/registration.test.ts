import { describe, expect, it } from "vitest";
import { registerEmail } from "../../src/services/registration.js";
import { ApiError } from "../../src/lib/errors.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import { makeTestDeps } from "../helpers/deps.js";
import { seedLegalDocuments } from "../helpers/app.js";

const validBody = {
  email: "new@example.com",
  password: "abcd1234",
  consents: {
    terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
    privacy_policy_ack: { accepted: true, documentVersion: "2026-11-01" },
    health_data_collection: { accepted: true, documentVersion: "2026-11-01" },
  },
  locale: "ja-JP",
};

describe("registerEmail", () => {
  it("登録成功: account+consents+台帳が作成され Auth が有効化される", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-1",
    });
    expect(r.registrationStatus).toBe("created");
    expect(r.onboardingState).toBe("profile_pending");

    // Auth ユーザーが有効
    const authUser = [...deps.fakeAuthAdmin.users.values()][0]!;
    expect(authUser.disabled).toBe(false);
    expect(authUser.email).toBe("new@example.com");

    // account / consents / operation 作成
    const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    const account = await deps.db.doc(`accounts/${uid}`).get();
    expect(account.exists).toBe(true);
    expect(account.data()!.accountStatus).toBe("onboarding_pending");
    const consents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(consents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    const ops = await deps.db.collection("registrationOperations").get();
    expect(ops.size).toBe(1);
    expect(ops.docs[0]!.data().status).toBe("enabled");

    // 監査イベント（uid ハッシュ化・生メールなし）
    const audits = await deps.db.collection("auditEvents").get();
    expect(audits.size).toBeGreaterThan(0);
    const auditData = audits.docs.map((d) => JSON.stringify(d.data())).join();
    expect(auditData).not.toContain("new@example.com");
  });

  it("同一 Idempotency-Key+同一本文の再送は新規作成せず成功を返す", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-1",
    });
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(deps.fakeAuthAdmin.users.size).toBe(1);
  });

  it("同一キー+異なる本文は 409 REGISTRATION_CONFLICT", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-1",
    });
    try {
      await registerEmail(deps, {
        body: { ...validBody, email: "other@example.com" },
        idempotencyKey: "key-1",
        requestId: "req-3",
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("REGISTRATION_CONFLICT");
    }
  });

  it("必須同意欠落は 400 で Auth ユーザーを作らない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const { terms_of_service: _t, ...consents } = validBody.consents;
    try {
      await registerEmail(deps, {
        body: { ...validBody, consents },
        idempotencyKey: "key-1",
        requestId: "req-1",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(400);
    }
    expect(deps.fakeAuthAdmin.users.size).toBe(0);
  });

  it("旧版の同意は 412 で Auth ユーザーを作らない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    try {
      await registerEmail(deps, {
        body: {
          ...validBody,
          consents: {
            ...validBody.consents,
            terms_of_service: { accepted: true, documentVersion: "2020-01-01" },
          },
        },
        idempotencyKey: "key-1",
        requestId: "req-1",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(412);
    }
    expect(deps.fakeAuthAdmin.users.size).toBe(0);
  });

  it("重複メールは 409 で Auth ユーザーは残さない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    deps.fakeAuthAdmin.users.set("existing", {
      email: "new@example.com",
      password: "x",
      emailVerified: true,
      disabled: false,
    });
    try {
      await registerEmail(deps, {
        body: validBody,
        idempotencyKey: "key-1",
        requestId: "req-1",
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("REGISTRATION_CONFLICT");
    }
    const accounts = await deps.db.collection("accounts").get();
    expect(accounts.size).toBe(0);
  });

  it("Auth作成後のFirestore失敗は台帳 failed になり再試行で収束する", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);

    // 1回目: transaction を失敗させて Firestore 書込みを塞ぐ
    const origRunTx = deps.memDb.runTransaction.bind(deps.memDb);
    deps.memDb.runTransaction = (async () => {
      throw new Error("firestore down");
    }) as typeof deps.memDb.runTransaction;
    try {
      await registerEmail(deps, {
        body: validBody,
        idempotencyKey: "key-1",
        requestId: "req-1",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).code).toBe("UPSTREAM_UNAVAILABLE");
      expect((e as ApiError).retryable).toBe(true);
    }
    // 台帳が failed で残る
    const ops = await deps.db.collection("registrationOperations").get();
    expect(ops.size).toBe(1);
    expect(ops.docs[0]!.data().status).toBe("failed");
    // Auth ユーザーは disabled で作成済み
    const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(true);

    // 2回目: 復旧 → 同一キーで再開し成功
    deps.memDb.runTransaction = origRunTx;
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    expect((await deps.db.doc(`accounts/${uid}`).get()).exists).toBe(true);
  });
});
