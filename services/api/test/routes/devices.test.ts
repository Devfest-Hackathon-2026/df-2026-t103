import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import type {
  AuditEventDoc,
  PushDeviceDoc,
} from "../../src/domain/firestoreDocs.js";

const UID = "u-dev-1";
const OTHER = "u-dev-2";
const TOKEN = "fcm-registration-token-aaa";
const TOKEN2 = "fcm-registration-token-bbb";

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  await seedAccount(deps, UID);
  await seedCurrentConsents(deps, UID);
  await seedAccount(deps, OTHER);
  await seedCurrentConsents(deps, OTHER);
  const app = buildTestApp(deps);
  return { deps, app };
}

async function auditEvents(
  deps: TestDeps,
): Promise<Array<AuditEventDoc & { id: string }>> {
  const snap = await deps.db.collection("auditEvents").get();
  return snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as AuditEventDoc),
  }));
}

describe("POST /v1/me/devices (API-042)", () => {
  it("トークンを登録して deviceId を返す", async () => {
    const { deps, app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), "idempotency-key": "k1" },
      payload: { token: TOKEN, platform: "android" },
    });
    expect(res.statusCode).toBe(201);
    const { deviceId } = res.json() as { deviceId: string };
    expect(deviceId).toMatch(/^pdv_[0-9a-f]{64}$/);

    const snap = await deps.db.doc(`pushDevices/${deviceId}`).get();
    const doc = snap.data() as PushDeviceDoc;
    expect(doc.patientUid).toBe(UID);
    expect(doc.token).toBe(TOKEN);
    expect(doc.status).toBe("active");

    const events = await auditEvents(deps);
    expect(events.map((e) => e.action)).toContain("PUSH_DEVICE_REGISTERED");
  });

  it("同一トークンの再登録は同一 deviceId に収束する", async () => {
    const { deps, app } = await setup();
    const first = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), "idempotency-key": "k1" },
      payload: { token: TOKEN, platform: "android" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), "idempotency-key": "k2" },
      payload: { token: TOKEN, platform: "ios" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(
      (first.json() as { deviceId: string }).deviceId,
    ).toBe((second.json() as { deviceId: string }).deviceId);

    const snap = await deps.db
      .doc(`pushDevices/${(second.json() as { deviceId: string }).deviceId}`)
      .get();
    expect((snap.data() as PushDeviceDoc).platform).toBe("ios");
  });

  it("同一Idempotency-Key+同一内容はリプレイし監査を重複発行しない", async () => {
    const { deps, app } = await setup();
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/me/devices",
        headers: { ...authHeader(UID), "idempotency-key": "k-replay" },
        payload: { token: TOKEN, platform: "android" },
      });
      expect(res.statusCode).toBe(201);
    }
    const events = (await auditEvents(deps)).filter(
      (e) => e.action === "PUSH_DEVICE_REGISTERED",
    );
    expect(events).toHaveLength(1);
  });

  it("同一キーで異なる内容は 409", async () => {
    const { app } = await setup();
    await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), "idempotency-key": "k-conflict" },
      payload: { token: TOKEN, platform: "android" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), "idempotency-key": "k-conflict" },
      payload: { token: TOKEN2, platform: "android" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("別アカウントが同じトークンを登録すると受信者が移る", async () => {
    const { deps, app } = await setup();
    await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(UID), "idempotency-key": "k1" },
      payload: { token: TOKEN, platform: "android" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(OTHER), "idempotency-key": "k2" },
      payload: { token: TOKEN, platform: "android" },
    });
    const { deviceId } = res.json() as { deviceId: string };
    const snap = await deps.db.doc(`pushDevices/${deviceId}`).get();
    // トークンはインストールに紐づくため、最後の登録者が受信者となる
    expect((snap.data() as PushDeviceDoc).patientUid).toBe(OTHER);
  });

  it("未認証は 401、不正プラットフォームは 400、キー欠落は 400", async () => {
    const { app } = await setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/devices",
          headers: { "idempotency-key": "k1" },
          payload: { token: TOKEN, platform: "android" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/devices",
          headers: { ...authHeader(UID), "idempotency-key": "k1" },
          payload: { token: TOKEN, platform: "toaster" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/devices",
          headers: authHeader(UID),
          payload: { token: TOKEN, platform: "android" },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("DELETE /v1/me/devices/:deviceId (API-043)", () => {
  async function register(app: FastifyInstance, uid: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/devices",
      headers: { ...authHeader(uid), "idempotency-key": `k-${uid}` },
      payload: { token: `${TOKEN}-${uid}`, platform: "android" },
    });
    return (res.json() as { deviceId: string }).deviceId;
  }

  it("本人のデバイスを解除する", async () => {
    const { deps, app } = await setup();
    const deviceId = await register(app, UID);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/me/devices/${deviceId}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(204);
    expect((await deps.db.doc(`pushDevices/${deviceId}`).get()).exists).toBe(
      false,
    );
    const events = await auditEvents(deps);
    expect(events.map((e) => e.action)).toContain("PUSH_DEVICE_UNREGISTERED");
  });

  it("他人のデバイス・不存在は 404（存在秘匿）", async () => {
    const { app } = await setup();
    const deviceId = await register(app, OTHER);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/me/devices/${deviceId}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(404);
    const missing = await app.inject({
      method: "DELETE",
      url: `/v1/me/devices/pdv_${"0".repeat(64)}`,
      headers: authHeader(UID),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("形式不正の deviceId は 400", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/me/devices/not-a-device",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(400);
  });
});
