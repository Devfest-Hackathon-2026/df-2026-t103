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
  OcrJobDoc,
  UploadDoc,
} from "../../src/domain/firestoreDocs.js";
import type { OcrCandidate } from "../../src/domain/ocr.js";

const UID = "u-med-1";
const OTHER = "u-med-2";

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

const CANDIDATES: OcrCandidate[] = [
  {
    candidateId: "c1",
    name: "ロキソプロフェンNa錠",
    strength: "60mg",
    dosage: "1日3回毎食後",
    quantity: "7日分",
    prescribedAt: "2026-04-01",
    confidence: 0.9,
  },
  {
    candidateId: "c2",
    name: "レボフロキサシン錠",
    strength: "500mg",
    dosage: "1日1回",
    quantity: "5日分",
    prescribedAt: null,
    confidence: 0.7,
  },
];

/** succeeded 状態の OCR ジョブ＋元 upload をシードする。 */
async function seedOcrJob(
  deps: TestDeps,
  jobId: string,
  patientUid = UID,
  status: OcrJobDoc["status"] = "succeeded",
): Promise<void> {
  await deps.db.doc(`uploads/up-${jobId}`).set({
    patientUid,
    storageBucket: "b",
    objectPath: "p",
    mimeType: "image/jpeg",
    bytes: 6,
    sha256: "a".repeat(64),
    status: "uploaded",
    sourcePurpose: "prescription_photo",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  } satisfies UploadDoc as unknown as Record<string, unknown>);
  await deps.db.doc(`ocrJobs/${jobId}`).set({
    uploadId: `up-${jobId}`,
    patientUid,
    status,
    engine: "fake",
    attempt: 1,
    errorCode: status === "failed" ? "indeterminate" : null,
    candidates: status === "succeeded" ? CANDIDATES : [],
    dispatchState: "enqueued",
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies OcrJobDoc as unknown as Record<string, unknown>);
}

describe("GET /v1/medications/extractions/:jobId (API-022)", () => {
  it("候補を unconfirmed のまま返す", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-1");
    const res = await app.inject({
      method: "GET",
      url: "/v1/medications/extractions/job-1",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("succeeded");
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].name).toBe("ロキソプロフェンNa錠");
    await app.close();
  });

  it("404: 他人のジョブ・不存在は秘匿", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-2");
    const other = await app.inject({
      method: "GET",
      url: "/v1/medications/extractions/job-2",
      headers: authHeader(OTHER),
    });
    const missing = await app.inject({
      method: "GET",
      url: "/v1/medications/extractions/nope",
      headers: authHeader(UID),
    });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /v1/medications (API-023)", () => {
  it("手入力登録: confirmed + sourceType=manual + 確認日時", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-1" },
      payload: {
        displayName: "ムコダイン錠",
        strength: "250mg",
        currentStatus: "taking",
      },
    });
    expect(res.statusCode).toBe(201);
    const med = res.json();
    expect(med.confirmationStatus).toBe("confirmed");
    expect(med.sourceType).toBe("manual");
    expect(med.userConfirmedAt).toBeTruthy();
    expect(med.currentStatus).toBe("taking");
    await app.close();
  });

  it("OCR候補からの登録: 候補値が既定になり出所が保持される", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-3");
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-2" },
      payload: {
        displayName: "ロキソプロフェンNa錠",
        ocrJobId: "job-3",
        candidateId: "c1",
        currentStatus: "taking",
      },
    });
    expect(res.statusCode).toBe(201);
    const med = res.json();
    expect(med.sourceType).toBe("prescription_photo");
    expect(med.ocrJobId).toBe("job-3");
    expect(med.uploadId).toBe("up-job-3");
    // 候補値の引き継ぎ
    expect(med.strength).toBe("60mg");
    expect(med.instructionsText).toBe("1日3回毎食後");
    expect(med.quantity).toBe("7日分");
    expect(med.prescribedAt).toBe("2026-04-01");
    await app.close();
  });

  it("候補値は利用者入力で上書きできる（E2E-003 修正導線）", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-4");
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-3" },
      payload: {
        displayName: "誤読された薬（修正済）",
        strength: "10mg",
        ocrJobId: "job-4",
        candidateId: "c1",
        currentStatus: "not_sure",
        confirmationStatus: "unconfirmed",
      },
    });
    expect(res.statusCode).toBe(201);
    const med = res.json();
    expect(med.strength).toBe("10mg");
    expect(med.confirmationStatus).toBe("unconfirmed");
    expect(med.currentStatus).toBe("not_sure");
    expect(med.userConfirmedAt).toBeNull();
    await app.close();
  });

  it("候補値は明示 null でクリアできる（誤ったOCR値の除去）", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-4b");
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-3b" },
      payload: {
        displayName: "ロキソプロフェンNa錠",
        prescribedAt: null,
        ocrJobId: "job-4b",
        candidateId: "c1",
        currentStatus: "taking",
      },
    });
    expect(res.statusCode).toBe(201);
    const med = res.json();
    // 誤認識された候補の処方日は復元されず null で保存される
    expect(med.prescribedAt).toBeNull();
    // 指定しなかった項目は候補値を引き継ぐ
    expect(med.strength).toBe("60mg");
    await app.close();
  });

  it("412: 未完了ジョブの候補は登録に使えない", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-5", UID, "running");
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-4" },
      payload: {
        displayName: "x",
        ocrJobId: "job-5",
        currentStatus: "taking",
      },
    });
    expect(res.statusCode).toBe(412);
    await app.close();
  });

  it("404: 他人のジョブは使えない", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-6", OTHER);
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-5" },
      payload: {
        displayName: "x",
        ocrJobId: "job-6",
        currentStatus: "taking",
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400: 存在しない候補ID", async () => {
    const { deps, app } = await setup();
    await seedOcrJob(deps, "job-7");
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-6" },
      payload: {
        displayName: "x",
        ocrJobId: "job-7",
        candidateId: "nope",
        currentStatus: "taking",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400: displayName 必須", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-7" },
      payload: { currentStatus: "taking" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("同一 Idempotency-Key の再送は同じ薬剤を返す", async () => {
    const { app } = await setup();
    const payload = { displayName: "A錠", currentStatus: "taking" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-8" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": "m-8" },
      payload,
    });
    expect(second.json().medicationId).toBe(first.json().medicationId);
    await app.close();
  });
});

describe("GET/PATCH/DELETE /v1/medications (API-024〜026)", () => {
  async function createMed(
    app: FastifyInstance,
    key: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(UID), "idempotency-key": key },
      payload,
    });
    return res.json().medicationId;
  }

  it("一覧は現在/過去/不明を区別して返す（FR-M05）", async () => {
    const { app } = await setup();
    await createMed(app, "l-1", { displayName: "A", currentStatus: "taking" });
    await createMed(app, "l-2", { displayName: "B", currentStatus: "past" });
    await createMed(app, "l-3", {
      displayName: "C",
      currentStatus: "not_sure",
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/medications",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const statuses = res
      .json()
      .medications.map((m: { currentStatus: string }) => m.currentStatus)
      .sort();
    expect(statuses).toEqual(["not_sure", "past", "taking"]);
    await app.close();
  });

  it("PATCH で編集・確定・添付フラグを更新できる", async () => {
    const { app } = await setup();
    const id = await createMed(app, "p-1", {
      displayName: "X錠",
      currentStatus: "taking",
      confirmationStatus: "unconfirmed",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/medications/${id}`,
      headers: authHeader(UID),
      payload: {
        strength: "50mg",
        confirmationStatus: "confirmed",
        attachToQuestionnaire: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const med = res.json();
    expect(med.strength).toBe("50mg");
    expect(med.confirmationStatus).toBe("confirmed");
    expect(med.userConfirmedAt).toBeTruthy();
    expect(med.attachToQuestionnaire).toBe(true);
    await app.close();
  });

  it("PATCH/DELETE は他人の薬剤を 404 にする", async () => {
    const { app } = await setup();
    const id = await createMed(app, "p-2", {
      displayName: "Y錠",
      currentStatus: "taking",
    });
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/medications/${id}`,
      headers: authHeader(OTHER),
      payload: { strength: "1mg" },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/medications/${id}`,
      headers: authHeader(OTHER),
    });
    expect(patch.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
    await app.close();
  });

  it("DELETE で物理削除し再DELETEは404", async () => {
    const { deps, app } = await setup();
    const id = await createMed(app, "d-1", {
      displayName: "Z錠",
      currentStatus: "past",
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/medications/${id}`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(204);
    const doc = await deps.db.doc(`medications/${id}`).get();
    expect(doc.exists).toBe(false);
    const again = await app.inject({
      method: "DELETE",
      url: `/v1/medications/${id}`,
      headers: authHeader(UID),
    });
    expect(again.statusCode).toBe(404);
    await app.close();
  });
});
