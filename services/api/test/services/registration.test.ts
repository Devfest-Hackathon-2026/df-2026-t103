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
    expect(ops.docs[0]!.data().uid).toBe(uid);

    // 監査イベント（uid ハッシュ化・生メールなし）
    const audits = await deps.db.collection("auditEvents").get();
    expect(audits.size).toBeGreaterThan(0);
    const auditData = audits.docs.map((d) => JSON.stringify(d.data())).join();
    expect(auditData).not.toContain("new@example.com");
  });

  it.each(["processing-ledger-deletion", "processing-ledger-replacement"] as const)(
    "Auth有効化後に台帳が%sされても成功応答しない",
    async (mutation) => {
      const deps = makeTestDeps();
      await seedLegalDocuments(deps);
      const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
        deps.fakeAuthAdmin,
      );
      deps.fakeAuthAdmin.updateUser = async (uid, props) => {
        const result = await originalUpdateUser(uid, props);
        const operation = (await deps.db
          .collection("registrationOperations")
          .get()).docs[0]!;
        if (mutation === "processing-ledger-deletion") {
          await operation.ref.delete();
        } else {
          await operation.ref.set({
            ...operation.data(),
            requestHash: "replacement-request-hash",
            uid: "replacement-uid",
            status: "reserved",
          });
        }
        return result;
      };

      await expect(
        registerEmail(deps, {
          body: validBody,
          idempotencyKey: mutation,
          requestId: `${mutation}-req`,
        }),
      ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

      expect(deps.fakeAuthAdmin.users.size).toBe(1);
      expect([...deps.fakeAuthAdmin.users.values()][0]!.disabled).toBe(false);
      expect((await deps.db.collection("accounts").get()).size).toBe(1);
      expect((await deps.db.collection("legalConsents").get()).size).toBe(
        DEV_LEGAL_DOCUMENTS.requiredConsents.length,
      );
    },
  );

  it("同一 Idempotency-Key+同一本文の再送は新規作成せず成功を返す", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-1",
    });
    const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    await deps.db.doc(`accounts/${uid}`).update({
      accountStatus: "active",
      onboardingState: "completed",
    });
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    const account = await deps.db.doc(`accounts/${uid}`).get();
    expect(account.data()!.uid).toBe(uid);
    expect(account.data()!.accountStatus).toBe("active");
    expect((await deps.db.collection("legalConsents").get()).size).toBe(
      DEV_LEGAL_DOCUMENTS.requiredConsents.length,
    );
    const operation = await deps.db.collection("registrationOperations").get();
    expect(operation.docs[0]!.data().uid).toBe(uid);
    expect(operation.docs[0]!.data().status).toBe("enabled");
  });

  it.each(["uid", "accountStatus"] as const)(
    "enabled再送でaccountの%s破損を検出し修復しない",
    async (corruptField) => {
      const deps = makeTestDeps();
      await seedLegalDocuments(deps);
      await registerEmail(deps, {
        body: validBody,
        idempotencyKey: `corrupt-account-${corruptField}`,
        requestId: "corrupt-account-create",
      });
      const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
      const accountRef = deps.db.doc(`accounts/${uid}`);
      if (corruptField === "uid") {
        await accountRef.update({ uid: "different-uid" });
      } else {
        await accountRef.update({ accountStatus: "corrupt" });
      }

      await expect(
        registerEmail(deps, {
          body: validBody,
          idempotencyKey: `corrupt-account-${corruptField}`,
          requestId: "corrupt-account-retry",
        }),
      ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

      const account = await accountRef.get();
      expect(account.data()!.uid).toBe(
        corruptField === "uid" ? "different-uid" : uid,
      );
      expect(account.data()!.accountStatus).toBe(
        corruptField === "accountStatus" ? "corrupt" : "onboarding_pending",
      );
      expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
      expect((await deps.db.collection("legalConsents").get()).size).toBe(
        DEV_LEGAL_DOCUMENTS.requiredConsents.length,
      );
    },
  );

  it.each(["pending_deletion", "deleted", "suspended"] as const)(
    "enabled済み再送はaccountStatus=%sでAuthを再有効化しない",
    async (accountStatus) => {
      const deps = makeTestDeps();
      await seedLegalDocuments(deps);
      const params = {
        body: validBody,
        idempotencyKey: `enabled-replay-${accountStatus}`,
        requestId: "enabled-replay-first",
      };
      await registerEmail(deps, params);
      const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
      deps.fakeAuthAdmin.users.get(uid)!.disabled = true;
      await deps.db.doc(`accounts/${uid}`).update({ accountStatus });
      let enableCalls = 0;
      deps.fakeAuthAdmin.updateUser = async () => {
        enableCalls += 1;
        throw new Error("enabled replay must not re-enable Auth");
      };

      await expect(
        registerEmail(deps, {
          ...params,
          requestId: "enabled-replay-retry",
        }),
      ).resolves.toMatchObject({ registrationStatus: "created" });

      expect(enableCalls).toBe(0);
      expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(true);
      expect((await deps.db.doc(`accounts/${uid}`).get()).data()!.accountStatus).toBe(
        accountStatus,
      );
    },
  );

  it.each(["uid", "accountStatus"] as const)(
    "consents_committed再開でaccountの%s破損ならAuthを有効化しない",
    async (corruptField) => {
      const deps = makeTestDeps();
      await seedLegalDocuments(deps);
      const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
        deps.fakeAuthAdmin,
      );
      let enableCalls = 0;
      deps.fakeAuthAdmin.updateUser = async (uid, props) => {
        enableCalls += 1;
        if (enableCalls === 1) throw new Error("transient Auth enable failure");
        return originalUpdateUser(uid, props);
      };
      const params = {
        body: validBody,
        idempotencyKey: `corrupt-resume-${corruptField}`,
        requestId: "corrupt-resume-first",
      };
      await expect(registerEmail(deps, params)).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });

      const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
      const accountRef = deps.db.doc(`accounts/${uid}`);
      if (corruptField === "uid") {
        await accountRef.update({ uid: "different-uid" });
      } else {
        await accountRef.update({ accountStatus: "corrupt" });
      }

      await expect(
        registerEmail(deps, {
          ...params,
          requestId: "corrupt-resume-retry",
        }),
      ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

      expect(enableCalls).toBe(1);
      expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(true);
      const account = await accountRef.get();
      expect(account.data()!.uid).toBe(
        corruptField === "uid" ? "different-uid" : uid,
      );
      expect(account.data()!.accountStatus).toBe(
        corruptField === "accountStatus" ? "corrupt" : "onboarding_pending",
      );
    },
  );

  it.each(["pending_deletion", "deleted", "suspended"] as const)(
    "consents_committed再開はaccountStatus=%sを有効化しない",
    async (accountStatus) => {
      const deps = makeTestDeps();
      await seedLegalDocuments(deps);
      const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
        deps.fakeAuthAdmin,
      );
      let enableCalls = 0;
      deps.fakeAuthAdmin.updateUser = async (uid, props) => {
        enableCalls += 1;
        if (enableCalls === 1) throw new Error("transient Auth enable failure");
        return originalUpdateUser(uid, props);
      };
      const params = {
        body: validBody,
        idempotencyKey: `resume-status-${accountStatus}`,
        requestId: "resume-status-first",
      };
      await expect(registerEmail(deps, params)).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });

      const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
      await deps.db.doc(`accounts/${uid}`).update({ accountStatus });
      await expect(
        registerEmail(deps, {
          ...params,
          requestId: "resume-status-retry",
        }),
      ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

      expect(enableCalls).toBe(1);
      expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(true);
      expect((await deps.db.doc(`accounts/${uid}`).get()).data()!.accountStatus).toBe(
        accountStatus,
      );
    },
  );

  it("consents_committed再開は進行済みactive accountを許容する", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
      deps.fakeAuthAdmin,
    );
    let enableCalls = 0;
    deps.fakeAuthAdmin.updateUser = async (uid, props) => {
      enableCalls += 1;
      if (enableCalls === 1) throw new Error("transient Auth enable failure");
      return originalUpdateUser(uid, props);
    };
    const params = {
      body: validBody,
      idempotencyKey: "resume-active-account",
      requestId: "resume-active-first",
    };
    await expect(registerEmail(deps, params)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    await deps.db.doc(`accounts/${uid}`).update({
      accountStatus: "active",
      onboardingState: "completed",
    });

    await expect(
      registerEmail(deps, {
        ...params,
        requestId: "resume-active-retry",
      }),
    ).resolves.toMatchObject({ registrationStatus: "created" });

    expect(enableCalls).toBe(2);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    const account = await deps.db.doc(`accounts/${uid}`).get();
    expect(account.data()!.accountStatus).toBe("active");
    expect(account.data()!.onboardingState).toBe("completed");
  });

  it("異なる登録キーの並行登録で進行中の disabled Auth を孤児回収しない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);

    let releaseFirstCreate!: () => void;
    let firstCreateStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstCreateStarted = resolve;
    });
    const allowFirstCreateToReturn = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const originalCreateUser = deps.fakeAuthAdmin.createUser.bind(
      deps.fakeAuthAdmin,
    );
    let isFirstCreate = true;
    deps.fakeAuthAdmin.createUser = async (props) => {
      const created = await originalCreateUser(props);
      if (isFirstCreate) {
        isFirstCreate = false;
        firstCreateStarted();
        await allowFirstCreateToReturn;
      }
      return created;
    };

    const firstRegistration = registerEmail(deps, {
      body: validBody,
      idempotencyKey: "concurrent-key-1",
      requestId: "concurrent-req-1",
    });
    await firstStarted;

    // 1件目が Auth を作成したが account をまだ記録していない区間。
    // 別キー側は競合として拒否し、進行中のAuthを削除しない。
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "concurrent-key-2",
        requestId: "concurrent-req-2",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

    releaseFirstCreate();
    await expect(firstRegistration).resolves.toMatchObject({
      registrationStatus: "created",
    });

    const accounts = await deps.db.collection("accounts").get();
    // Account があるなら対応する Auth ユーザーも残っていなければならない。
    for (const account of accounts.docs) {
      expect(deps.fakeAuthAdmin.users.has(account.id)).toBe(true);
    }
  });

  it("account のない disabled 孤児Authも別キー登録から削除せず409", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    deps.fakeAuthAdmin.users.set("orphan", {
      email: validBody.email,
      password: "not-used",
      emailVerified: false,
      disabled: true,
    });

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "new-operation-key",
        requestId: "orphan-req",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

    expect(deps.fakeAuthAdmin.users.has("orphan")).toBe(true);
    expect((await deps.db.collection("accounts").get()).size).toBe(0);
  });

  it("別キーはdisabled Authとonboarding_pending account/consentを引き継がず変更せず409", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const uid = "pending-orphan-owner";
    deps.fakeAuthAdmin.users.set(uid, {
      email: validBody.email,
      password: "fake-password-only",
      emailVerified: false,
      disabled: true,
    });
    const accountRef = deps.db.doc(`accounts/${uid}`);
    await accountRef.set({
      uid,
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
      emailVerified: false,
      providers: ["password"],
      schemaVersion: "1",
      createdAt: "fake-created-at",
      updatedAt: "fake-updated-at",
    });
    const consentRef = deps.db.collection("legalConsents").doc("fake-consent");
    await consentRef.set({
      subjectUid: uid,
      consentType: "terms_of_service",
      documentVersion: "fake-version",
      documentHash: "fake-hash",
      decision: "accepted",
      method: "explicit_checkbox",
      registrationSource: "email_registration",
      occurredAt: "fake-consent-time",
      revokedAt: null,
      schemaVersion: "1",
    });
    const originalAccount = (await accountRef.get()).data();
    const originalConsent = (await consentRef.get()).data();
    const recreatedUids: string[] = [];
    const reenabledUids: string[] = [];
    const deletedUids: string[] = [];
    const originalCreateUser = deps.fakeAuthAdmin.createUser.bind(
      deps.fakeAuthAdmin,
    );
    deps.fakeAuthAdmin.createUser = async (props) => {
      recreatedUids.push(props.uid);
      return originalCreateUser(props);
    };
    const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
      deps.fakeAuthAdmin,
    );
    deps.fakeAuthAdmin.updateUser = async (userUid, props) => {
      if (props.disabled === false) reenabledUids.push(userUid);
      return originalUpdateUser(userUid, props);
    };
    const originalDeleteUser = deps.fakeAuthAdmin.deleteUser.bind(
      deps.fakeAuthAdmin,
    );
    deps.fakeAuthAdmin.deleteUser = async (userUid) => {
      deletedUids.push(userUid);
      return originalDeleteUser(userUid);
    };

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "different-operation-key",
        requestId: "pending-orphan-req",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

    expect(deps.fakeAuthAdmin.users.get(uid)).toEqual({
      email: validBody.email,
      password: "fake-password-only",
      emailVerified: false,
      disabled: true,
    });
    expect(reenabledUids).not.toContain(uid);
    expect(deletedUids).not.toContain(uid);
    expect(recreatedUids).not.toContain(uid);
    expect((await accountRef.get()).data()).toEqual(originalAccount);
    expect((await consentRef.get()).data()).toEqual(originalConsent);
    expect((await deps.db.collection("accounts").get()).size).toBe(1);
    expect((await deps.db.collection("legalConsents").get()).size).toBe(1);
    const operations = await deps.db.collection("registrationOperations").get();
    expect(operations.size).toBe(1);
    expect(operations.docs[0]!.data().uid).not.toBe(uid);
  });

  it("有効化に失敗した未完登録は別キーでも同一内容なら孤児を引き継いで登録できる", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);

    // 1件目: 同意書コミット後のAuth有効化で失敗 → disabled 孤児 + onboarding_pending account
    deps.fakeAuthAdmin.failOn.add("update");
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "stuck-key-a",
        requestId: "stuck-req-a",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    deps.fakeAuthAdmin.failOn.delete("update");

    const orphanUid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    expect(deps.fakeAuthAdmin.users.get(orphanUid)!.disabled).toBe(true);

    // 別キー・同一本文の再試行は未完登録を引き継いで成功する
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "retry-key-b",
      requestId: "retry-req-b",
    });
    expect(r.registrationStatus).toBe("created");

    // 孤児uidが引き継がれ有効化され、account/同意は重複しない
    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect(deps.fakeAuthAdmin.users.get(orphanUid)!.disabled).toBe(false);
    expect((await deps.db.collection("accounts").get()).size).toBe(1);
    const consents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", orphanUid)
      .get();
    expect(consents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    const operations = await deps.db.collection("registrationOperations").get();
    const adopted = operations.docs
      .map((d) => d.data())
      .find((op) => op.uid === orphanUid && op.status === "enabled");
    expect(adopted).toBeDefined();
    const audits = await deps.db.collection("auditEvents").get();
    expect(
      audits.docs.some((d) => d.data().action === "REGISTRATION_REPAIRED"),
    ).toBe(true);
  });

  it("別キーでも本文が異なれば未完登録の孤児を引き継がず409", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    deps.fakeAuthAdmin.failOn.add("update");
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "stuck-key-a",
        requestId: "stuck-req-a",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    deps.fakeAuthAdmin.failOn.delete("update");

    const orphanUid = [...deps.fakeAuthAdmin.users.keys()][0]!;

    // 別キー・異なる本文（パスワード違い）は他人の未完登録として引き継がない
    await expect(
      registerEmail(deps, {
        body: { ...validBody, password: "wxyz9876" },
        idempotencyKey: "retry-key-b",
        requestId: "retry-req-b",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

    // 孤児は変更されず、新規台帳も孤児uidへ付け替えられない
    expect(deps.fakeAuthAdmin.users.get(orphanUid)!.disabled).toBe(true);
    const operations = await deps.db.collection("registrationOperations").get();
    const orphanOps = operations.docs
      .map((d) => d.data())
      .filter((op) => op.uid === orphanUid);
    expect(orphanOps).toHaveLength(1);
    expect(orphanOps[0]!.status).toBe("consents_committed");
    const audits = await deps.db.collection("auditEvents").get();
    expect(
      audits.docs.some((d) => d.data().action === "REGISTRATION_REPAIRED"),
    ).toBe(false);
  });

  it("引き継ぎ後に元キーでの再試行も同一アカウントに収束する", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    deps.fakeAuthAdmin.failOn.add("update");
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "stuck-key-a",
        requestId: "stuck-req-a",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    deps.fakeAuthAdmin.failOn.delete("update");

    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "retry-key-b",
      requestId: "retry-req-b",
    });

    const orphanUid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "stuck-key-a",
      requestId: "retry-req-a2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect((await deps.db.collection("accounts").get()).size).toBe(1);
    const operations = await deps.db.collection("registrationOperations").get();
    const ownerOp = operations.docs
      .map((d) => d.data())
      .find((op) => op.uid === orphanUid);
    expect(ownerOp).toBeDefined();
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
    let failFirstTransaction = true;
    deps.memDb.runTransaction = (async (callback) => {
      if (failFirstTransaction) {
        failFirstTransaction = false;
        throw new Error("firestore down");
      }
      return origRunTx(callback);
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
    deps.clock.advanceMs(24 * 60 * 60_000 + 1);
    const r = await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "key-1",
      requestId: "req-2",
    });
    expect(r.registrationStatus).toBe("created");
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    expect((await deps.db.doc(`accounts/${uid}`).get()).exists).toBe(true);
  });

  it("Auth有効化失敗後の同一キー再試行で同意履歴を重複させない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);

    const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
      deps.fakeAuthAdmin,
    );
    let failFirstEnable = true;
    deps.fakeAuthAdmin.updateUser = async (uid, props) => {
      if (failFirstEnable) {
        failFirstEnable = false;
        throw new Error("auth/update failed once");
      }
      return originalUpdateUser(uid, props);
    };

    const params = {
      body: validBody,
      idempotencyKey: "enable-retry-key",
      requestId: "enable-retry-req",
    };
    await expect(registerEmail(deps, params)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });

    const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    const accountRef = deps.db.doc(`accounts/${uid}`);
    expect((await accountRef.get()).exists).toBe(true);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(true);
    const initialConsents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(initialConsents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    const operationAfterEnableFailure = await deps.db
      .collection("registrationOperations")
      .get();
    expect(operationAfterEnableFailure.docs[0]!.data().status).toBe(
      "consents_committed",
    );
    const failedAudits = await deps.db.collection("auditEvents").get();
    expect(
      failedAudits.docs.some((doc) => doc.data().outcome === "failed"),
    ).toBe(true);

    await expect(registerEmail(deps, params)).resolves.toMatchObject({
      registrationStatus: "created",
    });

    const finalConsents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(finalConsents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    expect((await accountRef.get()).exists).toBe(true);
    const finalOperation = await deps.db.collection("registrationOperations").get();
    expect(finalOperation.docs[0]!.data().status).toBe("enabled");

  });

  it("期限切れenabledの同一キー再送は新たに同意を発行しない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await registerEmail(deps, {
      body: validBody,
      idempotencyKey: "expired-enabled-key",
      requestId: "expired-enabled-req",
    });
    deps.clock.advanceMs(24 * 60 * 60_000 + 1);

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "expired-enabled-key",
        requestId: "expired-enabled-retry",
      }),
    ).resolves.toMatchObject({ registrationStatus: "created" });

    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect((await deps.db.collection("registrationOperations").get()).size).toBe(1);
    expect((await deps.db.collection("legalConsents").get()).size).toBe(
      DEV_LEGAL_DOCUMENTS.requiredConsents.length,
    );
  });

  it("期限切れ同一キーの遅延reserveは並行完了済み状態を上書きしない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const originalRunTransaction = deps.memDb.runTransaction.bind(deps.memDb);
    let failInitialTransaction = true;
    deps.memDb.runTransaction = (async (callback) => {
      if (failInitialTransaction) {
        failInitialTransaction = false;
        throw new Error("initial Firestore failure");
      }
      return originalRunTransaction(callback);
    }) as typeof deps.memDb.runTransaction;
    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "expired-concurrent-reserve-key",
        requestId: "expired-concurrent-initial",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    deps.memDb.runTransaction = originalRunTransaction;
    deps.clock.advanceMs(24 * 60 * 60_000 + 1);

    let releaseFirstReserve!: () => void;
    let firstReserveStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstReserveStarted = resolve;
    });
    const allowFirstReserve = new Promise<void>((resolve) => {
      releaseFirstReserve = resolve;
    });
    let holdNextTransaction = true;
    deps.memDb.runTransaction = (async (callback) => {
      if (holdNextTransaction) {
        holdNextTransaction = false;
        firstReserveStarted();
        await allowFirstReserve;
      }
      return originalRunTransaction(callback);
    }) as typeof deps.memDb.runTransaction;

    const params = {
      body: validBody,
      idempotencyKey: "expired-concurrent-reserve-key",
      requestId: "expired-concurrent-retry",
    };
    const delayedAttempt = registerEmail(deps, params);
    await firstStarted;
    await expect(registerEmail(deps, params)).resolves.toMatchObject({
      registrationStatus: "created",
    });
    releaseFirstReserve();
    await expect(delayedAttempt).resolves.toMatchObject({
      registrationStatus: "created",
    });

    const operation = await deps.db.collection("registrationOperations").get();
    const uid = operation.docs[0]!.data().uid as string;
    expect(operation.docs[0]!.data().status).toBe("enabled");
    expect((await deps.db.collection("legalConsents").get()).size).toBe(
      DEV_LEGAL_DOCUMENTS.requiredConsents.length,
    );
    expect((await deps.db.doc(`accounts/${uid}`).get()).exists).toBe(true);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
  });

  it("遅れて到着したAuth失敗記録は並行再試行のenabled状態を退行させない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);

    let releaseFirstEnable!: () => void;
    let firstEnableStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEnableStarted = resolve;
    });
    const allowFirstFailure = new Promise<void>((resolve) => {
      releaseFirstEnable = resolve;
    });
    const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
      deps.fakeAuthAdmin,
    );
    let isFirstEnable = true;
    deps.fakeAuthAdmin.updateUser = async (uid, props) => {
      if (isFirstEnable) {
        isFirstEnable = false;
        firstEnableStarted();
        await allowFirstFailure;
        throw new Error("auth/update failed after retry");
      }
      return originalUpdateUser(uid, props);
    };

    const params = {
      body: validBody,
      idempotencyKey: "concurrent-enable-key",
      requestId: "concurrent-enable-req",
    };
    const firstAttempt = registerEmail(deps, params);
    await firstStarted;

    await expect(registerEmail(deps, params)).resolves.toMatchObject({
      registrationStatus: "created",
    });
    releaseFirstEnable();
    await expect(firstAttempt).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });

    const uid = [...deps.fakeAuthAdmin.users.keys()][0]!;
    const consents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(consents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    expect((await deps.db.doc(`accounts/${uid}`).get()).exists).toBe(true);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    const operation = await deps.db.collection("registrationOperations").get();
    expect(operation.docs[0]!.data().status).toBe("enabled");
  });

  it("期限切れconsents_committedの同一キー再試行で同意履歴を重複させない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
      deps.fakeAuthAdmin,
    );
    let failFirstEnable = true;
    deps.fakeAuthAdmin.updateUser = async (uid, props) => {
      if (failFirstEnable) {
        failFirstEnable = false;
        throw new Error("auth/update failed once");
      }
      return originalUpdateUser(uid, props);
    };

    const params = {
      body: validBody,
      idempotencyKey: "expired-consents-committed-key",
      requestId: "expired-consents-committed-req",
    };
    await expect(registerEmail(deps, params)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });

    const operationRef = (await deps.db.collection("registrationOperations").get())
      .docs[0]!;
    expect(operationRef.data().status).toBe("consents_committed");
    const uid = operationRef.data().uid as string;
    const initialConsents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(initialConsents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);

    deps.clock.advanceMs(24 * 60 * 60_000 + 1);
    await expect(
      registerEmail(deps, {
        ...params,
        body: { ...validBody, email: "different@example.com" },
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });
    await expect(registerEmail(deps, params)).resolves.toMatchObject({
      registrationStatus: "created",
    });

    const finalOperation = await deps.db.collection("registrationOperations").get();
    expect(finalOperation.docs[0]!.data().status).toBe("enabled");
    expect(finalOperation.docs[0]!.data().uid).toBe(uid);
    const finalConsents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", uid)
      .get();
    expect(finalConsents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    expect((await deps.db.doc(`accounts/${uid}`).get()).exists).toBe(true);
    expect(deps.fakeAuthAdmin.users.get(uid)!.disabled).toBe(false);
    expect((await deps.db.collection("legalConsents").get()).size).toBe(
      DEV_LEGAL_DOCUMENTS.requiredConsents.length,
    );
  });

  it("操作台帳が物理削除済みならdisabled Authへ引継がず409", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const originalUpdateUser = deps.fakeAuthAdmin.updateUser.bind(
      deps.fakeAuthAdmin,
    );
    deps.fakeAuthAdmin.updateUser = async () => {
      throw new Error("auth/update unavailable");
    };
    const params = {
      body: validBody,
      idempotencyKey: "deleted-operation-key",
      requestId: "deleted-operation-req",
    };
    await expect(registerEmail(deps, params)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    deps.fakeAuthAdmin.updateUser = originalUpdateUser;

    const originalOperation = (await deps.db
      .collection("registrationOperations")
      .get()).docs[0]!;
    const originalUid = originalOperation.data().uid as string;
    await originalOperation.ref.delete();

    await expect(registerEmail(deps, params)).rejects.toMatchObject({
      code: "REGISTRATION_CONFLICT",
    });
    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect(deps.fakeAuthAdmin.users.get(originalUid)!.disabled).toBe(true);
    expect((await deps.db.doc(`accounts/${originalUid}`).get()).exists).toBe(true);
    expect((await deps.db.collection("legalConsents").get()).size).toBe(
      DEV_LEGAL_DOCUMENTS.requiredConsents.length,
    );
  });

  it.each([
    ["台帳消失", "missing"],
    ["operationHash置換", "operationHash"],
    ["requestHash置換", "requestHash"],
    ["UID置換", "uid"],
    ["予期しないstatus", "status"],
  ] as const)("transaction中に%sを検出したら書込み前に409", async (_name, mutation) => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const originalRunTransaction = deps.memDb.runTransaction.bind(deps.memDb);
    let transactionNumber = 0;
    deps.memDb.runTransaction = (async (callback) => {
      transactionNumber += 1;
      if (transactionNumber === 2) {
        const operation = (await deps.db
          .collection("registrationOperations")
          .get()).docs[0]!;
        const ref = operation.ref;
        const data = operation.data();
        if (mutation === "missing") {
          await ref.delete();
        } else if (mutation === "operationHash") {
          await ref.set({ ...data, operationHash: "replaced-operation-hash" });
        } else if (mutation === "requestHash") {
          await ref.set({ ...data, requestHash: "replaced-request-hash" });
        } else if (mutation === "uid") {
          await ref.set({ ...data, uid: "replaced-uid" });
        } else {
          await ref.set({ ...data, status: "expired" });
        }
      }
      return originalRunTransaction(callback);
    }) as typeof deps.memDb.runTransaction;

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: `ledger-${mutation}-key`,
        requestId: `ledger-${mutation}-req`,
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect([...deps.fakeAuthAdmin.users.values()][0]!.disabled).toBe(true);
    expect((await deps.db.collection("accounts").get()).size).toBe(0);
    expect((await deps.db.collection("legalConsents").get()).size).toBe(0);
    const audits = await deps.db.collection("auditEvents").get();
    expect(audits.docs.some((doc) => doc.data().outcome === "conflict")).toBe(true);
  });

  it("transaction callback再試行で置換済みrequestHashを読み直しfail-closed", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const originalRunTransaction = deps.memDb.runTransaction.bind(deps.memDb);
    let transactionNumber = 0;
    deps.memDb.runTransaction = (async (callback) => {
      transactionNumber += 1;
      if (transactionNumber !== 2) return originalRunTransaction(callback);

      return originalRunTransaction(async (tx) => {
        const retryTx = Object.create(tx) as typeof tx;
        retryTx.get = tx.get.bind(tx);
        retryTx.set = async () => retryTx;
        retryTx.create = async () => retryTx;
        await callback(retryTx);

        // Emulate a transaction retry after another writer replaced the row.
        const operation = (await deps.db
          .collection("registrationOperations")
          .get()).docs[0]!;
        await operation.ref.set({
          ...operation.data(),
          requestHash: "replaced-during-retry",
        });
        return callback(tx);
      });
    }) as typeof deps.memDb.runTransaction;

    await expect(
      registerEmail(deps, {
        body: validBody,
        idempotencyKey: "ledger-retry-key",
        requestId: "ledger-retry-req",
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_CONFLICT" });

    expect(deps.fakeAuthAdmin.users.size).toBe(1);
    expect([...deps.fakeAuthAdmin.users.values()][0]!.disabled).toBe(true);
    expect((await deps.db.collection("accounts").get()).size).toBe(0);
    expect((await deps.db.collection("legalConsents").get()).size).toBe(0);
    const audits = await deps.db.collection("auditEvents").get();
    expect(audits.docs.some((doc) => doc.data().outcome === "conflict")).toBe(true);
  });
});
