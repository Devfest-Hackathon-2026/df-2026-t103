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
import type { UploadDoc } from "../../src/domain/firestoreDocs.js";

const UID = "u-upload-1";
const OTHER_UID = "u-upload-2";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SHA = "a".repeat(64);

async function setup(
  configOverrides: Parameters<typeof makeTestDeps>[0] = {},
): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps(configOverrides);
  await seedLegalDocuments(deps);
  await seedAccount(deps, UID);
  await seedCurrentConsents(deps, UID);
  await seedAccount(deps, OTHER_UID);
  await seedCurrentConsents(deps, OTHER_UID);
  const app = buildTestApp(deps);
  return { deps, app };
}

function initPayload(overrides: Record<string, unknown> = {}) {
  return {
    fileName: "prescription.jpg",
    mimeType: "image/jpeg",
    bytes: JPEG_BYTES.length,
    sha256: SHA,
    sourcePurpose: "prescription_photo",
    ...overrides,
  };
}

async function initUpload(
  app: FastifyInstance,
  key: string,
  payload: Record<string, unknown> = initPayload(),
) {
  return app.inject({
    method: "POST",
    url: "/v1/uploads/init",
    headers: { ...authHeader(UID), "idempotency-key": key },
    payload,
  });
}

async function completeUpload(
  app: FastifyInstance,
  uid: string,
  uploadId: string,
  key: string,
) {
  return app.inject({
    method: "POST",
    url: `/v1/uploads/${uploadId}/complete`,
    headers: { ...authHeader(uid), "idempotency-key": key },
    payload: {},
  });
}

async function getUploadDoc(
  deps: TestDeps,
  uploadId: string,
): Promise<UploadDoc | undefined> {
  const snap = await deps.db.doc(`uploads/${uploadId}`).get();
  return snap.data() as UploadDoc | undefined;
}

describe("POST /v1/uploads/init (API-019)", () => {
  it("201: 所有者スコープの短命署名URLを発行する", async () => {
    const { deps, app } = await setup();
    const res = await initUpload(app, "up-init-1");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.upload.method).toBe("PUT");
    expect(body.upload.url).toContain("/patient-uploads/");
    expect(body.upload.headers["content-type"]).toBe("image/jpeg");
    // 短命URL: 15分以内の期限
    const ttlMs = Date.parse(body.upload.expiresAt) - deps.clock.now().getTime();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(900 * 1000);

    const doc = await getUploadDoc(deps, body.uploadId);
    expect(doc?.patientUid).toBe(UID);
    expect(doc?.status).toBe("pending");
    expect(doc?.objectPath).toBe(
      `patient-uploads/${UID}/${body.uploadId}/original`,
    );
    expect(deps.fakeStorage.uploadUrlCalls[0]?.objectPath).toBe(
      doc?.objectPath,
    );
    await app.close();
  });

  it("400: 非対応MIMEは拒否", async () => {
    const { app } = await setup();
    const res = await initUpload(
      app,
      "k",
      initPayload({ mimeType: "image/gif" }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("413: 10MB 超過は FILE_TOO_LARGE", async () => {
    const { app } = await setup();
    const res = await initUpload(
      app,
      "k",
      initPayload({ bytes: 10 * 1024 * 1024 + 1 }),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("FILE_TOO_LARGE");
    await app.close();
  });

  it("400: Idempotency-Key 必須", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/uploads/init",
      headers: authHeader(UID),
      payload: initPayload(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("401: 未認証は拒否", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/uploads/init",
      headers: { "idempotency-key": "k" },
      payload: initPayload(),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("412: 有効アップロード数の上限で拒否", async () => {
    const { deps, app } = await setup({ uploadMaxActive: 1 });
    await deps.db.collection("uploads").doc("existing-1").set({
      patientUid: UID,
      status: "pending",
      storageBucket: "b",
      objectPath: "p",
      mimeType: "image/jpeg",
      bytes: 10,
      sha256: SHA,
      sourcePurpose: "prescription_photo",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const res = await initUpload(app, "k2");
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("PRECONDITION_FAILED");
    await app.close();
  });

  it("同一 Idempotency-Key の再送は同じ uploadId を返す", async () => {
    const { app } = await setup();
    const first = await initUpload(app, "same-key");
    const second = await initUpload(app, "same-key");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().uploadId).toBe(first.json().uploadId);
    await app.close();
  });
});

describe("POST /v1/uploads/:id/complete (API-020)", () => {
  it("200: 実オブジェクトを検証して uploaded に遷移", async () => {
    const { deps, app } = await setup();
    const init = await initUpload(app, "i-1");
    const uploadId = init.json().uploadId;
    const doc = (await getUploadDoc(deps, uploadId))!;
    deps.fakeStorage.seedObject(
      doc.storageBucket,
      doc.objectPath,
      JPEG_BYTES,
      "image/jpeg",
    );

    const res = await completeUpload(app, UID, uploadId, "c-1");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("uploaded");

    const after = (await getUploadDoc(deps, uploadId))!;
    expect(after.status).toBe("uploaded");
    expect(after.contentScanStatus).toBe("passed");
    expect(after.objectGeneration).toBeTruthy();
    await app.close();
  });

  it("412: Storage にオブジェクトが無い", async () => {
    const { app } = await setup();
    const init = await initUpload(app, "i-2");
    const res = await completeUpload(app, UID, init.json().uploadId, "c-2");
    expect(res.statusCode).toBe(412);
    await app.close();
  });

  it("400: サイズ不一致（申告≠実オブジェクト）", async () => {
    const { deps, app } = await setup();
    const init = await initUpload(app, "i-3");
    const uploadId = init.json().uploadId;
    const doc = (await getUploadDoc(deps, uploadId))!;
    deps.fakeStorage.seedObject(
      doc.storageBucket,
      doc.objectPath,
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x99, 0x99]),
      "image/jpeg",
    );
    const res = await completeUpload(app, UID, uploadId, "c-3");
    expect(res.statusCode).toBe(400);
    const after = (await getUploadDoc(deps, uploadId))!;
    expect(after.status).toBe("rejected");
    await app.close();
  });

  it("400: 内容が宣言と異なる（偽装ファイル）は拒否・削除される", async () => {
    const { deps, app } = await setup();
    // 申告は JPEG、中身は PDF。サイズとメタ contentType は申告どおりに偽装。
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const init = await initUpload(
      app,
      "i-5",
      initPayload({ bytes: pdf.length }),
    );
    const uploadId = init.json().uploadId;
    const doc = (await getUploadDoc(deps, uploadId))!;
    deps.fakeStorage.seedObject(
      doc.storageBucket,
      doc.objectPath,
      pdf,
      "image/jpeg",
    );

    const res = await completeUpload(app, UID, uploadId, "c-5");
    expect(res.statusCode).toBe(400);
    const after = (await getUploadDoc(deps, uploadId))!;
    expect(after.status).toBe("rejected");
    expect(after.contentScanStatus).toBe("failed");
    expect(deps.fakeStorage.deleted.map((d) => d.path)).toContain(
      doc.objectPath,
    );
    await app.close();
  });

  it("404: 他人のアップロードは存在自体を秘匿", async () => {
    const { app } = await setup();
    const init = await initUpload(app, "i-6");
    const res = await completeUpload(
      app,
      OTHER_UID,
      init.json().uploadId,
      "c-6",
    );
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404: 存在しないID", async () => {
    const { app } = await setup();
    const res = await completeUpload(app, UID, "no-such-id", "c-x");
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("412: 期限切れの pending は expired に遷移して拒否", async () => {
    const { deps, app } = await setup();
    const init = await initUpload(app, "i-7");
    const uploadId = init.json().uploadId;
    deps.clock.advanceMs(31 * 24 * 3600_000);
    const res = await completeUpload(app, UID, uploadId, "c-7");
    expect(res.statusCode).toBe(412);
    const after = (await getUploadDoc(deps, uploadId))!;
    expect(after.status).toBe("expired");
    await app.close();
  });

  it("200: complete 済みへの再送は冪等に uploaded を返す", async () => {
    const { deps, app } = await setup();
    const init = await initUpload(app, "i-8");
    const uploadId = init.json().uploadId;
    const doc = (await getUploadDoc(deps, uploadId))!;
    deps.fakeStorage.seedObject(
      doc.storageBucket,
      doc.objectPath,
      JPEG_BYTES,
      "image/jpeg",
    );
    const first = await completeUpload(app, UID, uploadId, "c-8");
    const second = await completeUpload(app, UID, uploadId, "c-9");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("uploaded");
    await app.close();
  });
});

describe("GET /v1/uploads/:id/processing (API-021)", () => {
  it("200: アップロード状態と ocrJob=null を返す", async () => {
    const { app } = await setup();
    const init = await initUpload(app, "i-9");
    const uploadId = init.json().uploadId;
    const res = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/processing`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending");
    expect(res.json().ocrJob).toBeNull();
    await app.close();
  });

  it("404: 他人のリソースは秘匿", async () => {
    const { app } = await setup();
    const init = await initUpload(app, "i-10");
    const res = await app.inject({
      method: "GET",
      url: `/v1/uploads/${init.json().uploadId}/processing`,
      headers: authHeader(OTHER_UID),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
