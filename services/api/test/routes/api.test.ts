import { createHash } from "node:crypto";
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

// /healthz は LB 用の疎通確認であり、認証・接続先の真正性・Auth emulator の状態は
// 検証しない。emulator フラグは設定値の表示であって、UI や本番接続の安全性を保証しない。
describe.each(["/health", "/healthz"])("GET %s", (healthPath) => {
  it("200 + 依存状態 ok を返す（認証不要）", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: healthPath });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.firestore).toBe("ok");
    expect(body.checkedAt).toBeTruthy();
    expect(res.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("Firestore 障害時は 503 + degraded", async () => {
    const deps = makeTestDeps();
    // Firestore プローブが必ず失敗するよう db を差し替える
    deps.db = {
      doc: () => ({
        get: () => Promise.reject(new Error("firestore down")),
      }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: healthPath });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.firestore).toBe("error");
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("emulator フラグは設定値をそのまま返す（接続先の検証ではない）", async () => {
    for (const [config, expected] of [
      [{}, true],
      [{ emulator: false, projectId: "real-project" }, false],
    ] as const) {
      const deps = makeTestDeps(config);
      const app = buildTestApp(deps);
      const res = await app.inject({ method: "GET", url: healthPath });
      expect(res.statusCode).toBe(200);
      expect(res.json().emulator).toBe(expected);
      expect(res.headers["cache-control"]).toBe("no-store");
      await app.close();
    }
  });

  it("Firestore がハングしてもプローブタイムアウトで 503 になる", async () => {
    const deps = makeTestDeps({ healthzProbeTimeoutMs: 30 });
    deps.db = {
      doc: () => ({ get: () => new Promise(() => {}) }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: healthPath });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.firestore).toBe("error");
    await app.close();
  });

  it("App Check enforce 下でも認証なしで到達できる（LB想定）", async () => {
    const deps = makeTestDeps({ appCheckMode: "enforce" });
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: healthPath });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("プローブ対象ドキュメントが無くても read が成立すれば ok", async () => {
    const deps = makeTestDeps();
    // seedLegalDocuments なし: appConfigs/publicLegalVersion は存在しない
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: healthPath });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.firestore).toBe("ok");
    await app.close();
  });

  it("プローブ結果を短期キャッシュし期限後に再プローブする", async () => {
    const deps = makeTestDeps({ healthzProbeCacheMs: 5_000 });
    let probeCount = 0;
    const origDoc = deps.db.doc.bind(deps.db);
    deps.db.doc = ((path: string) => {
      if (path === "appConfigs/publicLegalVersion") probeCount++;
      return origDoc(path);
    }) as typeof deps.db.doc;
    const app = buildTestApp(deps);

    const r1 = await app.inject({ method: "GET", url: healthPath });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers["cache-control"]).toBe("no-store");
    expect(r1.json().service).toBe("mmr-api");
    const r2 = await app.inject({ method: "GET", url: healthPath });
    expect(r2.statusCode).toBe(200);
    expect(probeCount).toBe(1);

    // キャッシュ期限経過で再プローブ
    deps.clock.advanceMs(5_001);
    const r3 = await app.inject({ method: "GET", url: healthPath });
    expect(r3.statusCode).toBe(200);
    expect(probeCount).toBe(2);
    await app.close();
  });

  it("キャッシュ期限後は回復を検知して 200 に戻る", async () => {
    const deps = makeTestDeps({ healthzProbeCacheMs: 1_000 });
    let fail = true;
    deps.db = {
      doc: () => ({
        get: () =>
          fail ? Promise.reject(new Error("down")) : Promise.resolve({}),
      }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    const r1 = await app.inject({ method: "GET", url: healthPath });
    expect(r1.statusCode).toBe(503);
    fail = false;
    // キャッシュ内はまだ degraded
    const r2 = await app.inject({ method: "GET", url: healthPath });
    expect(r2.statusCode).toBe(503);
    deps.clock.advanceMs(1_001);
    const r3 = await app.inject({ method: "GET", url: healthPath });
    expect(r3.statusCode).toBe(200);
    await app.close();
  });

  it("同時到着は進行中プローブを共有し Firestore read は1回になる", async () => {
    const deps = makeTestDeps();
    let probeCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    deps.db = {
      doc: () => ({
        get: async () => {
          probeCount++;
          await gate;
          return { exists: false };
        },
      }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    // プローブが解決しない間に並行リクエストを発行する
    const pending = Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: "GET", url: healthPath }),
      ),
    );
    // 全ハンドラが inflight に張り付くまで1マイクロタスク回す
    await new Promise((r) => setImmediate(r));
    release();
    const results = await pending;
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(probeCount).toBe(1);
    await app.close();
  });
});

describe("GET /v1/public/legal-documents", () => {
  it.each([true, false])("文書本文はハッシュ一致時だけ公開する: %s", async (matches) => {
    const { deps, app } = await setup();
    const text = "合成データの文書本文です。";
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      ...DEV_LEGAL_DOCUMENTS,
      documents: {
        ...DEV_LEGAL_DOCUMENTS.documents,
        terms_of_service: {
          ...DEV_LEGAL_DOCUMENTS.documents.terms_of_service,
          text,
          documentHash: matches ? "sha256:" + createHash("sha256").update(text).digest("hex") : "sha256:wrong",
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/public/legal-documents" });
    expect(res.statusCode).toBe(200);
    expect(res.json().documents.terms_of_service.text).toBe(matches ? text : undefined);
    await app.close();
  });

  it("現行文書セット（版・ハッシュ・必須一覧）を返す", async () => {
    const { deps, app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(200);
    // 版ローテーションの伝播を経路キャッシュが遅らせないよう no-store
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.requiredConsents).toContain("terms_of_service");
    // 再同意検知に必要なメタ: 必須同意の全種別に現行版+正式ハッシュがある
    for (const type of body.requiredConsents) {
      const doc = body.documents[type];
      expect(doc?.version, `${type}.version`).toBeTruthy();
      expect(doc?.documentHash, `${type}.documentHash`).toMatch(/^sha256:/);
      expect(doc?.publishedAt, `${type}.publishedAt`).toBeTruthy();
    }
    expect(body.updatedAt).toBe(deps.clock.now().toISOString());
    // 再同意検知に使う hospital_disclosure も現行版として公開される
    expect(body.documents.hospital_disclosure.version).toBeTruthy();
    await app.close();
  });

  it("文書未設定なら 503 + retryable", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(res.json().error.retryable).toBe(true);
    await app.close();
  });

  it("Firestore 読取自体が失敗しても 503 UPSTREAM_UNAVAILABLE + Retry-After", async () => {
    const deps = makeTestDeps();
    deps.db = {
      doc: () => ({ get: () => Promise.reject(new Error("down")) }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(res.json().error.retryable).toBe(true);
    expect(res.headers["retry-after"]).toBeTruthy();
    await app.close();
  });

  it("読取失敗も短期キャッシュされ回復後も TTL 内は 503 のまま", async () => {
    const deps = makeTestDeps();
    let readCount = 0;
    let fail = true;
    deps.db = {
      doc: () => ({
        get: async () => {
          readCount++;
          if (fail) throw new Error("down");
          return { exists: false, data: () => undefined };
        },
      }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    const r1 = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(r1.statusCode).toBe(503);
    expect(readCount).toBe(1);
    // 障害解消後もキャッシュ内は失敗を返す（read 連打しない）
    fail = false;
    const r2 = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(r2.statusCode).toBe(503);
    expect(readCount).toBe(1);
    // TTL 経過で再読 → 回復を検知
    deps.clock.advanceMs(10_001);
    const r3 = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(r3.statusCode).toBe(503); // 文書未設定なので引き続き 503 だが read は走る
    expect(readCount).toBe(2);
    await app.close();
  });

  it("同時到着は進行中 read を共有し Firestore read は1回になる", async () => {
    const deps = makeTestDeps();
    let readCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    deps.db = {
      doc: () => ({
        get: async () => {
          readCount++;
          await gate;
          return { exists: false, data: () => undefined };
        },
      }),
    } as unknown as TestDeps["db"];
    const app = buildTestApp(deps);
    const pending = Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "GET",
          url: "/v1/public/legal-documents",
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    release();
    const results = await pending;
    expect(results.every((r) => r.statusCode === 503)).toBe(true);
    expect(readCount).toBe(1);
    await app.close();
  });

  it("requiredConsents が配列でない壊れた設定でも 503（500にならない）", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: "terms_of_service",
      documents: {},
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("文書エントリの余計なキーは応答に含めない", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: {
        terms_of_service: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: "2026-11-01T00:00:00Z",
          internalNote: "法務レビュー中",
        },
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json().documents.terms_of_service;
    expect(doc.version).toBe("2026-11-01");
    expect(doc.documentHash).toBe("sha256:abc");
    expect(doc.internalNote).toBeUndefined();
    await app.close();
  });

  it("documents が壊れた値でも 503（500にならない）", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: "not-an-object",
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("requiredConsents にプロトタイプ名が混ざっても誤判定しない", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service", "toString"],
      documents: {
        terms_of_service: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: "2026-11-01T00:00:00Z",
        },
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    // toString の文書が無いので設定不備として 503
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("publishedAt が Timestamp 型でも ISO に正規化される", async () => {
    const { Timestamp } = await import("firebase-admin/firestore");
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: {
        terms_of_service: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: Timestamp.fromDate(new Date("2026-11-01T00:00:00Z")),
        },
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documents.terms_of_service.publishedAt).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    await app.close();
  });

  it("requiredConsents に非文字列・未知種別が混ざっていても 503", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service", 123],
      documents: {
        terms_of_service: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: "2026-11-01T00:00:00Z",
        },
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("未知の同意種別が必須に含まれていても 503", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service", "terms_of_sarvice"],
      documents: {
        terms_of_service: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: "2026-11-01T00:00:00Z",
        },
        terms_of_sarvice: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: "2026-11-01T00:00:00Z",
        },
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("非必須文書のメタ不備はその文書だけ落として 200", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: {
        terms_of_service: {
          version: "2026-11-01",
          documentHash: "sha256:abc",
          publishedAt: "2026-11-01T00:00:00Z",
        },
        hospital_disclosure: { version: "", documentHash: "" },
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documents.terms_of_service.version).toBe("2026-11-01");
    expect(body.documents.hospital_disclosure).toBeUndefined();
    await app.close();
  });

  it("必須同意一覧が空なら設定不備として 503", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      documents: {},
      requiredConsents: [],
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("必須種別の版・ハッシュが欠落していても 503", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: { terms_of_service: { version: "2026-11-01" } },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("publicRead レート制限を超えると 429", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const app = buildTestApp(deps);
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/public/legal-documents",
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });

  it("XFF 経由でクライアントIP単位のレートバケットになる", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    const app = buildTestApp(deps);
    // 同一ソケット・異なるXFFで送信。trustProxy が効いていれば
    // XFF 最終エントリがバケットキーになり、A で枯渇しても B は通る
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/public/legal-documents",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    const other = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.20" },
    });
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it("App Check enforce 時はトークン必須・有効トークンで 200", async () => {
    const deps = makeTestDeps({ appCheckMode: "enforce" });
    await seedLegalDocuments(deps);
    const app = buildTestApp(deps);
    const denied = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("APP_CHECK_FAILED");
    const ok = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
      headers: { "x-firebase-appcheck": "valid-appcheck" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("法務文書の読取は短期キャッシュされ期限後に再読する", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    let readCount = 0;
    const origDoc = deps.db.doc.bind(deps.db);
    deps.db.doc = ((path: string) => {
      if (path === "appConfigs/publicLegalVersion") readCount++;
      return origDoc(path);
    }) as typeof deps.db.doc;
    const app = buildTestApp(deps);
    const r1 = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(r2.statusCode).toBe(200);
    expect(readCount).toBe(1);
    // キャッシュTTL(10秒)経過で再読
    deps.clock.advanceMs(10_001);
    const r3 = await app.inject({
      method: "GET",
      url: "/v1/public/legal-documents",
    });
    expect(r3.statusCode).toBe(200);
    expect(readCount).toBe(2);
    await app.close();
  });
});

describe("アクセス階層の宣言漏れ", () => {
  it("未登録の /v1/* パスは 500 でなく 404 を返す", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("/v1/* の未宣言ルートは fail-closed、プラグイン系経路は許可", async () => {
    const { enforceAccess } = await import("../../src/auth/gates.js");
    const deps = makeTestDeps();
    const businessReq = {
      is404: false,
      routeOptions: { config: {}, url: "/v1/future" },
      url: "/v1/future",
    } as unknown as Parameters<typeof enforceAccess>[1];
    await expect(enforceAccess(deps, businessReq)).rejects.toMatchObject({
      statusCode: 500,
    });
    const pluginReq = {
      is404: false,
      routeOptions: { config: {}, url: "/docs/json" },
      url: "/docs/json",
    } as unknown as Parameters<typeof enforceAccess>[1];
    await expect(
      enforceAccess(deps, pluginReq),
    ).resolves.toBeUndefined();
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

  it("不正トークンは AUTH_FAIL 監査を記録する（UID不明・決定=deny）", async () => {
    const { deps, app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer garbage" },
    });
    expect(res.statusCode).toBe(401);
    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "AUTH_FAIL")
      .get();
    expect(audits.size).toBe(1);
    const ev = audits.docs[0]!.data()!;
    expect(ev.actorType).toBe("patient");
    // トークンが信用できないため actorUidHash は付けない
    expect(ev.actorUidHash).toBeUndefined();
    expect(ev.decision).toBe("deny");
    expect(ev.requestId).toBeTruthy();
    expect(JSON.stringify(ev)).not.toContain("garbage");
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

  it("法務設定が壊れていると同意ゲートは fail-closed（500）", async () => {
    const deps = makeTestDeps();
    // requiredConsents が配列でない壊れた設定。getLegalDocuments は
    // 未設定扱い（undefined）を返し、evaluateConsents は 500 で閉じる
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: "terms_of_service",
      documents: {},
    });
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { familyName: "田中" },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it("必須種別の文書が欠落していても同意ゲートは fail-closed（500）", async () => {
    const deps = makeTestDeps();
    // requiredConsents 自体は正しいが文書が無い → ユーザー起因でなく
    // 設定不備として 500（412 で「再同意しても直らない」状態にしない）
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: {},
    });
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { familyName: "田中" },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it("法務設定の読取自体が失敗した場合は同意ゲートも 503 retryable", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
    });
    // 法務設定の read のみ失敗させ（他の doc read は生かす）、
    // 一時障害が 500 INTERNAL ではなく 503 UPSTREAM_UNAVAILABLE に分類されることを検証
    const realDoc = deps.db.doc.bind(deps.db);
    deps.db.doc = ((path: string) =>
      path === "appConfigs/publicLegalVersion"
        ? { get: () => Promise.reject(new Error("down")) }
        : realDoc(path)) as TestDeps["db"]["doc"];
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { familyName: "田中" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(res.json().error.retryable).toBe(true);
    await app.close();
  });

  it("同意履歴の読取失敗も同意ゲートは 503 retryable", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID, {
      accountStatus: "onboarding_pending",
      onboardingState: "profile_pending",
    });
    // legalConsents クエリのみ失敗させ、法務設定 read は正常に通す
    const realCollection = deps.db.collection.bind(deps.db);
    deps.db.collection = ((name: string) => {
      if (name !== "legalConsents") return realCollection(name);
      const failing: Record<string, unknown> = {};
      failing.where = () => failing;
      failing.orderBy = () => failing;
      failing.limit = () => failing;
      failing.get = () => Promise.reject(new Error("down"));
      return failing;
    }) as TestDeps["db"]["collection"];
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(UID),
      payload: { familyName: "田中" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(res.json().error.retryable).toBe(true);
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

  it("不正な secret と未知の consent enum を拒否し、secret を応答に含めない", async () => {
    const { app } = await setup();
    const secret = "SecretMissingDigits";
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "idempotency-key": "reg-negative-secret" },
      payload: {
        ...payload,
        password: secret,
        consents: { ...payload.consents, admin_override: { accepted: true, documentVersion: "v1" } },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);
    expect(res.json().error.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringContaining("consents") }),
      ]),
    );
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
    const final = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "idempotency-key": "reg-final" },
      payload: { ...payload, email: "final@example.com" },
    });
    expect(final.statusCode).toBe(429);
    expect(final.headers["retry-after"]).toBeTruthy();
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
  it("法務設定が壊れていると同意提出も 503/500 で拒否される", async () => {
    const deps = makeTestDeps();
    // 必須種別の文書が欠落した設定（validateConsentSubmission → 500）
    await deps.db.doc("appConfigs/publicLegalVersion").set({
      requiredConsents: ["terms_of_service"],
      documents: {},
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/consents",
      headers: { ...authHeader("u-broken"), "idempotency-key": "oc-broken" },
      payload: {
        consents: {
          terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
        },
      },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

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
      "/health",
      "/healthz",
      "/v1/public/legal-documents",
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
