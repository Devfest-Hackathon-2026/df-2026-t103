import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import { createOcrJobForUpload } from "../../src/services/ocr.js";
import { OcrWorker } from "../../src/workers/ocrJob.js";
import type {
  OcrJobDoc,
  UploadDoc,
} from "../../src/domain/firestoreDocs.js";
import type { OcrCandidate } from "../../src/domain/ocr.js";

const UID = "u-ocr-1";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function seedUpload(
  deps: TestDeps,
  uploadId: string,
  status: UploadDoc["status"] = "uploaded",
  mimeType = "image/jpeg",
): Promise<UploadDoc> {
  const doc: UploadDoc = {
    patientUid: UID,
    storageBucket: "test-bucket",
    objectPath: `patient-uploads/${UID}/${uploadId}/original`,
    mimeType,
    bytes: JPEG_BYTES.length,
    sha256: "a".repeat(64),
    status,
    sourcePurpose: "prescription_photo",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  };
  await deps.db.doc(`uploads/${uploadId}`).set(doc as unknown as Record<string, unknown>);
  return doc;
}

async function getJob(deps: TestDeps, jobId: string): Promise<OcrJobDoc> {
  const snap = await deps.db.doc(`ocrJobs/${jobId}`).get();
  return snap.data() as OcrJobDoc;
}

const CANDIDATE: OcrCandidate = {
  candidateId: "c1",
  name: "ロキソプロフェンNa錠",
  strength: "60mg",
  dosage: "1日3回毎食後",
  quantity: "7日分",
  prescribedAt: "2026-04-01",
  confidence: 0.82,
  evidenceSpan: { start: 10, end: 42 },
};

describe("createOcrJobForUpload（complete後フック）", () => {
  it("queued ジョブを作成してキュー投入する", async () => {
    const deps = makeTestDeps();
    const { jobId, created } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    expect(created).toBe(true);
    expect(deps.fakeOcrQueue.enqueued).toEqual([jobId]);
    // FR-O04: jobId は uploadId の HMAC 擬名で、生の uploadId を露出しない
    expect(jobId).not.toBe("up-1");
    expect(jobId).toMatch(/^oj_[0-9a-f]{64}$/);
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("queued");
    expect(job.patientUid).toBe(UID);
  });

  it("進行中ジョブがあれば再利用する（冪等）", async () => {
    const deps = makeTestDeps();
    const first = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const second = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(deps.fakeOcrQueue.enqueued).toHaveLength(1);
  });

  it("enqueue 失敗でもジョブは queued のまま残り、次の呼び出しで回収される", async () => {
    const deps = makeTestDeps();
    deps.fakeOcrQueue.failNext = true;
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("queued");
    expect(job.dispatchState).toBe("pending");

    // 後続呼び出し（complete冪等リプレイ等）で未投入ジョブを再投入する
    const second = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    expect(second.jobId).toBe(jobId);
    expect(second.created).toBe(false);
    expect(deps.fakeOcrQueue.enqueued).toEqual([jobId]);
    expect((await getJob(deps, jobId)).dispatchState).toBe("enqueued");
  });

  it("enqueue 済みジョブの再利用では再投入しない", async () => {
    const deps = makeTestDeps();
    const first = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    await createOcrJobForUpload(deps, { uploadId: "up-1", patientUid: UID });
    expect(deps.fakeOcrQueue.enqueued).toEqual([first.jobId]);
  });
});

describe("OcrWorker.runJob", () => {
  it("候補を抽出して succeeded。候補は確認前のまま保存される", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = {
      ok: true,
      candidates: [CANDIDATE],
      extractedText: "処方箋テキスト…",
    };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const worker = new OcrWorker(deps);
    const res = await worker.runJob(jobId);
    expect(res.outcome).toBe("succeeded");
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("succeeded");
    expect(job.candidates).toHaveLength(1);
    // 候補は evidence 付き・確定フィールドなし（VAL-013: 自動確定しない）
    expect(job.candidates[0]).toEqual(CANDIDATE);
    expect(job.extractedText).toBe("処方箋テキスト…");
    expect(job.errorCode).toBeNull();
  });

  it("成功時は登録デバイスへ一般文言で通知し、終端ジョブ再実行では再送しない", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("pushDevices/pdv_test1").set({
      patientUid: UID,
      token: "tok-ocr-1",
      platform: "android",
      status: "active",
      invalidatedReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
    });
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = {
      ok: true,
      candidates: [CANDIDATE],
    };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const worker = new OcrWorker(deps);
    await worker.runJob(jobId);
    expect(deps.fakePush.calls).toHaveLength(1);
    const call = deps.fakePush.calls[0]!;
    expect(call.token).toBe("tok-ocr-1");
    // 候補の薬剤名（ロキソプロフェンNa錠）は通知に含めない（FR-O05）
    expect(call.title).not.toContain("ロキソプロフェン");
    expect(call.body).not.toContain("ロキソプロフェン");
    expect(JSON.stringify(call.data ?? {})).not.toContain("ロキソプロフェン");
    expect(call.data).toEqual({
      type: "OCR_EXTRACTION_READY",
      refId: jobId,
    });

    // 終端ジョブの再実行では通知を再送しない（at-least-once配送の二重化防止）
    const again = await worker.runJob(jobId);
    expect(again.outcome).toBe("already_terminal");
    expect(deps.fakePush.calls).toHaveLength(1);
  });

  it("終端失敗では通知しない", async () => {
    const deps = makeTestDeps();
    await deps.db.doc("pushDevices/pdv_test2").set({
      patientUid: UID,
      token: "tok-ocr-2",
      platform: "android",
      status: "active",
      invalidatedReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
    });
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = { ok: false, code: "not_prescription" };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("failed_terminal");
    expect(deps.fakePush.calls).toHaveLength(0);
  });

  it("終端失敗（not_prescription）は failed + errorCode", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = { ok: false, code: "not_prescription" };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("failed_terminal");
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("not_prescription");
  });

  it("再試行可能失敗は queued に戻り、上限到達で failed になる", async () => {
    const deps = makeTestDeps({ ocrMaxAttempts: 2 });
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.shouldThrow = true;
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const worker = new OcrWorker(deps);
    const r1 = await worker.runJob(jobId);
    expect(r1.outcome).toBe("failed_retryable");
    expect((await getJob(deps, jobId)).status).toBe("queued");
    expect((await getJob(deps, jobId)).attempt).toBe(1);
    const r2 = await worker.runJob(jobId);
    expect(r2.outcome).toBe("failed_terminal");
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("engine_unavailable");
  });

  it("PDF 6頁超は page_limit_exceeded（暫定上限5頁）", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1", "uploaded", "application/pdf");
    const pages = Array.from({ length: 6 }, (_, i) =>
      `obj${i}<</Type /Page>>`,
    ).join("\n");
    deps.fakeStorage.seedObject(
      "test-bucket",
      `patient-uploads/${UID}/up-1/original`,
      new TextEncoder().encode(`%PDF-1.4\n${pages}`),
      "application/pdf",
    );
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("failed_terminal");
    const job = await getJob(deps, jobId);
    expect(job.errorCode).toBe("page_limit_exceeded");
    expect(deps.fakeOcrEngine.calls).toBe(0); // 前処理で落ちてエンジン未呼出
  });

  it("upload が uploaded でなければ upload_invalid", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1", "pending");
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("failed_terminal");
    expect((await getJob(deps, jobId)).errorCode).toBe("upload_invalid");
  });

  it("終端ジョブの再実行は冪等", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const worker = new OcrWorker(deps);
    await worker.runJob(jobId);
    const again = await worker.runJob(jobId);
    expect(again.outcome).toBe("already_terminal");
    expect(deps.fakeOcrEngine.calls).toBe(1);
  });

  it("不存在ジョブは not_found", async () => {
    const deps = makeTestDeps();
    const res = await new OcrWorker(deps).runJob("no-such");
    expect(res.outcome).toBe("not_found");
  });

  it("リース有効な running ジョブは二重実行しない", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    // 他ワーカーがリース中の状態を再現
    await deps.db.doc(`ocrJobs/${jobId}`).update({
      status: "running",
      attempt: 1,
      claimOwner: "other-worker",
      claimExpiresAt: Timestamp.fromMillis(
        deps.clock.now().getTime() + 60_000,
      ),
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("already_running");
    expect(deps.fakeOcrEngine.calls).toBe(0);
  });

  it("リース切れの running ジョブは回収して再実行する", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = { ok: true, candidates: [CANDIDATE] };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    // ワーカーが中断しリースが切れた状態を再現
    await deps.db.doc(`ocrJobs/${jobId}`).update({
      status: "running",
      attempt: 1,
      claimOwner: "dead-worker",
      claimExpiresAt: Timestamp.fromMillis(
        deps.clock.now().getTime() - 1_000,
      ),
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("succeeded");
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("succeeded");
    expect(job.attempt).toBe(2);
  });

  it("リース切れかつ最終attemptの running は worker_interrupted で終端化", async () => {
    const deps = makeTestDeps({ ocrMaxAttempts: 2 });
    await seedUpload(deps, "up-1");
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    // attempt 上限到達済みで放棄された running（永遠に running のまま残る状態を防止）
    await deps.db.doc(`ocrJobs/${jobId}`).update({
      status: "running",
      attempt: 2,
      claimOwner: "dead-worker",
      claimExpiresAt: Timestamp.fromMillis(
        deps.clock.now().getTime() - 1_000,
      ),
    });
    const res = await new OcrWorker(deps).runJob(jobId);
    expect(res.outcome).toBe("already_terminal");
    expect(res.errorCode).toBe("worker_interrupted");
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("worker_interrupted");
    expect(deps.fakeOcrEngine.calls).toBe(0);
    // claim tx 内で終端化した経路でも OCR_JOB_FAILED が記録される
    const audits = await deps.memDb
      .collection("auditEvents")
      .where("action", "==", "OCR_JOB_FAILED")
      .get();
    expect(audits.size).toBe(1);
    const ev = audits.docs[0]!.data()!;
    expect((ev.details as { errorCode?: string } | undefined)?.errorCode).toBe("worker_interrupted");
    expect(ev.resourceIdHash).not.toBe(jobId);
  });

  it("claim 失効後の遅延完了は結果を上書きしない", async () => {
    const deps = makeTestDeps({ ocrLeaseMs: 10 });
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = { ok: true, candidates: [CANDIDATE] };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    // ワーカーAがclaim（リース10ms）→ リース切れ → ワーカーBが回収
    const workerA = new OcrWorker(deps);
    const runA = workerA.runJob(jobId); // claim → extract
    await Promise.resolve();
    const resA = await runA;
    // A の実行が完走した場合は succeeded（完了前にBが走ることはない直列ケース）
    expect(resA.outcome).toBe("succeeded");
    // 遅延してBの重複実行が来ても terminal は上書きされない
    const resB = await new OcrWorker(deps).runJob(jobId);
    expect(resB.outcome).toBe("already_terminal");
    expect((await getJob(deps, jobId)).status).toBe("succeeded");
  });

  it("extractedText は上限で切り詰めて証跡保存", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = {
      ok: true,
      candidates: [],
      extractedText: "x".repeat(30_000),
    };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    await new OcrWorker(deps).runJob(jobId);
    const job = await getJob(deps, jobId);
    expect(job.extractedText).toHaveLength(20_000);
    expect(job.extractedTextTruncated).toBe(true);
  });
});

describe("processing・internal run ルート配線", () => {
  it("complete 後に GET processing が ocrJob を返す（非PHIのみ）", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);
    const app = buildTestApp(deps);

    const init = await app.inject({
      method: "POST",
      url: "/v1/uploads/init",
      headers: { ...authHeader(UID), "idempotency-key": "i-ocr" },
      payload: {
        mimeType: "image/jpeg",
        bytes: JPEG_BYTES.length,
        sha256: "a".repeat(64),
        sourcePurpose: "prescription_photo",
      },
    });
    const uploadId = init.json().uploadId;
    const doc = (
      await deps.db.doc(`uploads/${uploadId}`).get()
    ).data() as UploadDoc;
    deps.fakeStorage.seedObject(
      doc.storageBucket,
      doc.objectPath,
      JPEG_BYTES,
      "image/jpeg",
    );
    await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      headers: { ...authHeader(UID), "idempotency-key": "c-ocr" },
      payload: {},
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/processing`,
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const job = res.json().ocrJob;
    expect(job).not.toBeNull();
    expect(job.status).toBe("queued");
    expect(job.candidateCount).toBe(0);
    // 非PHI: jobId/status/errorCode/candidateCount のみ
    expect(Object.keys(job).sort()).toEqual([
      "candidateCount",
      "errorCode",
      "jobId",
      "status",
    ]);
    await app.close();
  });

  it("internal run エンドポイントがジョブを実行する", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.result = { ok: true, candidates: [CANDIDATE] };
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/v1/internal/jobs/ocr/${jobId}/run`,
      headers: { "x-internal-job-token": "test-internal-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("succeeded");
    const job = await getJob(deps, jobId);
    expect(job.status).toBe("succeeded");
    await app.close();
  });

  it("リース中の already_running は 500（Tasks 再送用）", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    // 他ワーカーのリース有効状態を再現
    await deps.db.doc(`ocrJobs/${jobId}`).update({
      status: "running",
      attempt: 1,
      claimOwner: "other-worker",
      claimExpiresAt: Timestamp.fromMillis(
        deps.clock.now().getTime() + 60_000,
      ),
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/v1/internal/jobs/ocr/${jobId}/run`,
      headers: { "x-internal-job-token": "test-internal-token" },
    });
    // 200だとタスクが消費され回収配送が来ないため 5xx を返す
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it("再試行可能失敗は 500（Tasks 再送用）", async () => {
    const deps = makeTestDeps();
    await seedUpload(deps, "up-1");
    deps.fakeOcrEngine.shouldThrow = true;
    const { jobId } = await createOcrJobForUpload(deps, {
      uploadId: "up-1",
      patientUid: UID,
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/v1/internal/jobs/ocr/${jobId}/run`,
      headers: { "x-internal-job-token": "test-internal-token" },
    });
    expect(res.statusCode).toBe(500);
    expect((await getJob(deps, jobId)).status).toBe("queued");
    await app.close();
  });

  it("internal トークンなしは 403", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/jobs/ocr/some-id/run",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
