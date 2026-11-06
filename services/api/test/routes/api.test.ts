import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";

const UID = "u-route-1";

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  const app = buildTestApp(deps);
  return { deps, app };
}

describe("GET /healthz", () => {
  it("200 を返す（認証不要）", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });
});

describe("GET /v1/public/legal-documents", () => {
  it("現行文書セットを返す", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requiredConsents).toContain("terms_of_service");
    expect(body.documents.terms_of_service.version).toBe("2026-11-01");
    await app.close();
  });
});

describe("認証ガード", () => {
  it("Authorization 無しは 401", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
    await app.close();
  });

  it("不正トークンは 401", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer garbage" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("失効ユーザーは 401", async () => {
    const { deps, app } = await setup();
    deps.fakeAuth.revoked.add(UID);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("App Check enforce 時にトークン無しは 401 APP_CHECK_FAILED", async () => {
    const deps = makeTestDeps({ appCheckMode: "enforce" });
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("APP_CHECK_FAILED");

    const ok = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { ...authHeader(UID), "x-firebase-appcheck": "valid-appcheck" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("pending_deletion は通常 API を遮断し /me と退会APIは通る", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID, { accountStatus: "pending_deletion" });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/profile",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(403);

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authHeader(UID),
    });
    expect(me.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /v1/me", () => {
  it("アカウント状態・同意状態・プロフィール完了度を返す", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID, { accountStatus: "pending_deletion" });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uid).toBe(UID);
    expect(body.accountStatus).toBe("pending_deletion");
    expect(body.requiredConsents.current).toBe(false);
    expect(body.deletionRequest.status).toBe("pending_deletion");
    await app.close();
  });
});

describe("GET /v1/me/profile", () => {
  const medicalHistory = [{
    conditionText: "合成の病歴",
    selfReported: true,
    updatedAt: "2026-11-01T00:00:00.000Z",
  }];

  it("初回同意前は保存済みプロフィールを返さない", async () => {
    const { deps, app } = await setup();
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "legal_pending",
    });
    await deps.db.doc(`patientProfiles/${UID}`).set({
      patientUid: UID, profileComplete: false, medicalHistory,
    });
    const res = await app.inject({
      method: "GET", url: "/v1/me/profile", headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("PRECONDITION_FAILED");
    expect(res.body).not.toContain("合成の病歴");
    await app.close();
  });

  it("旧版同意では保存済みプロフィールを返さない", async () => {
    const { deps, app } = await setup();
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      ...DEV_LEGAL_DOCUMENTS,
      documents: {
        ...DEV_LEGAL_DOCUMENTS.documents,
        health_data_collection: {
          ...DEV_LEGAL_DOCUMENTS.documents.health_data_collection!,
          version: "2026-12-01",
        },
      },
    });
    await deps.db.doc(`patientProfiles/${UID}`).set({
      patientUid: UID, profileComplete: true, medicalHistory,
    });
    const res = await app.inject({
      method: "GET", url: "/v1/me/profile", headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("PRECONDITION_FAILED");
    expect(res.body).not.toContain("合成の病歴");
    await app.close();
  });

  it("現行同意済みならプロフィールを返す", async () => {
    const { deps, app } = await setup();
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
    });
    await seedCurrentConsents(deps, UID);
    await deps.db.doc(`patientProfiles/${UID}`).set({
      patientUid: UID, profileComplete: false, medicalHistory,
    });
    const res = await app.inject({
      method: "GET", url: "/v1/me/profile", headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.medicalHistory).toEqual(medicalHistory);
    await app.close();
  });
});

describe("PATCH /v1/me/profile", () => {
  it("同意未完了（legal_pending）は 412 で保存しない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "legal_pending",
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { familyName: "田中" },
    });
    expect(res.statusCode).toBe(412);
    expect((await deps.db.doc(`patientProfiles/${UID}`).get()).exists).toBe(
      false,
    );
    await app.close();
  });

  it("現行同意済みなら保存され、必須項目充足で active になる", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
    });
    await seedCurrentConsents(deps, UID);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: {
        familyName: "田中",
        givenName: "太郎",
        familyNameKana: "タナカ",
        givenNameKana: "タロウ",
        birthDate: "1990-05-15",
        phoneNumber: "09012345678",
        postalCode: "1234567",
        address: {
          prefecture: "東京都",
          city: "渋谷区",
          line1: "神南1-1-1",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profileComplete).toBe(true);
    const account = await deps.db.doc(`accounts/${UID}`).get();
    expect(account.data()!.accountStatus).toBe("active");
    expect(account.data()!.onboardingState).toBe("completed");
    await app.close();
  });

  it("バリデーションエラーは 400 + fieldErrors", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { birthDate: "2999-01-01" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.fieldErrors.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("POST /v1/auth/register", () => {
  const payload = {
    email: "route@example.com",
    password: "abcd1234",
    consents: {
      terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
      privacy_policy_ack: { accepted: true, documentVersion: "2026-11-01" },
      health_data_collection: { accepted: true, documentVersion: "2026-11-01" },
    },
  };

  it("201 + 登録結果を返す", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "idempotency-key": "reg-1" },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().registrationStatus).toBe("created");
    await app.close();
  });

  it("Idempotency-Key 無しは 400", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("レート制限超過は 429 + Retry-After", async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        headers: { "idempotency-key": `reg-${i}` },
        payload: { ...payload, email: `u${i}@example.com` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });
});

describe("POST /v1/me/deletion-request → cancel → status", () => {
  it("申請→状態確認→取消の一連の流れ", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    const app = buildTestApp(deps);

    const del = await app.inject({
      method: "POST",
      url: "/v1/me/deletion-request",
      headers: { ...authHeader(UID), "idempotency-key": "del-1" },
      payload: {},
    });
    expect(del.statusCode).toBe(202);
    expect(del.json().status).toBe("pending_deletion");

    const status = await app.inject({
      method: "GET",
      url: "/v1/me/deletion-request",
      headers: authHeader(UID),
    });
    expect(status.json().status).toBe("pending_deletion");
    expect(status.json().canCancel).toBe(true);

    // pending_deletion 中は profile PATCH は遮断
    const blocked = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { familyName: "x" },
    });
    expect(blocked.statusCode).toBe(403);

    const cancel = await app.inject({
      method: "POST",
      url: "/v1/me/deletion-request/cancel",
      headers: { ...authHeader(UID), "idempotency-key": "del-c1" },
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    await app.close();
  });

  it("ボディ省略でも受理される（payload なし）", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/deletion-request",
      headers: { ...authHeader(UID), "idempotency-key": "del-nobody" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending_deletion");
    await app.close();
  });

  it("auth_time が古いと 403 REAUTH_REQUIRED", async () => {
    const deps = makeTestDeps({ reauthWindowSeconds: 60 });
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    deps.fakeAuth.authTimeByToken.set(
      `token-${UID}`,
      Math.floor(deps.clock.now().getTime() / 1000) - 3600,
    );
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/deletion-request",
      headers: { ...authHeader(UID), "idempotency-key": "del-1" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("REAUTH_REQUIRED");
    await app.close();
  });
});

describe("POST /v1/onboarding/consents", () => {
  it("現行同意の記録で profile_pending に進む", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/consents",
      headers: { ...authHeader("new-user"), "idempotency-key": "oc-1" },
      payload: {
        consents: {
          terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
          privacy_policy_ack: { accepted: true, documentVersion: "2026-11-01" },
          health_data_collection: {
            accepted: true,
            documentVersion: "2026-11-01",
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().onboardingState).toBe("profile_pending");
    const consents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", "new-user")
      .get();
    expect(consents.size).toBe(3);
    await app.close();
  });
});

describe("GET /docs (OpenAPI)", () => {
  it("仕様 JSON を返し、主要ルートを含む", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    for (const p of [
      "/healthz",
      "/v1/auth/register",
      "/v1/me",
      "/v1/me/deletion-request",
      "/v1/internal/jobs/deletion-scan",
    ]) {
      expect(spec.paths[p]).toBeTruthy();
    }
    // zod ボディスキーマが JSON Schema 化されている
    const registerBody =
      spec.paths["/v1/auth/register"].post.requestBody.content[
        "application/json"
      ].schema;
    expect(registerBody.type).toBe("object");
    await app.close();
  });
});

describe("internal deletion-scan", () => {
  it("内部トークンでスキャンを実行できる", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/jobs/deletion-scan",
      headers: { "x-internal-job-token": "test-internal-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().scanned).toBe(0);
    await app.close();
  });

  it("トークン不一致は 403", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/jobs/deletion-scan",
      headers: { "x-internal-job-token": "wrong" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
