import { describe, expect, it } from "vitest";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { DeletionWorker } from "../../src/workers/deletionJob.js";
import { CLAIM_TTL_MS, initialSteps } from "../../src/domain/deletion.js";
import type { DeletionJobDoc } from "../../src/domain/firestoreDocs.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { seedAccount } from "../helpers/app.js";

const UID = "u-worker-1";

async function seedJob(
  deps: TestDeps,
  opts: {
    executeAfterMs?: number;
    requestedAtMs?: number;
    status?: DeletionJobDoc["status"];
    attemptCount?: number;
    uid?: string;
  } = {},
): Promise<string> {
  const uid = opts.uid ?? UID;
  const ref = deps.db.collection("deletionJobs").doc();
  const job: DeletionJobDoc = {
    subjectUid: uid,
    requestedAt: Timestamp.fromMillis(
      opts.requestedAtMs ?? deps.clock.now().getTime(),
    ),
    executeAfter: Timestamp.fromMillis(
      opts.executeAfterMs ?? deps.clock.now().getTime() - 1000,
    ),
    status: opts.status ?? "scheduled",
    steps: initialSteps(),
    attemptCount: opts.attemptCount ?? 0,
    lastErrorCode: null,
  };
  await ref.set(job as unknown as Record<string, unknown>);
  return ref.id;
}

/** 患者の全ストアにデータを仕込む。 */
async function seedPatientData(deps: TestDeps, uid = UID): Promise<void> {
  await seedAccount(deps, uid, { accountStatus: "pending_deletion" });
  await deps.db.doc(`patientProfiles/${uid}`).set({
    patientUid: uid,
    familyName: "テスト",
    profileComplete: true,
    locale: "ja-JP",
    updatedAt: FieldValue.serverTimestamp(),
  });
  // intake + サブコレクション
  await deps.db.doc("intakes/i1").set({ patientUid: uid });
  await deps.db.doc("intakes/i1/visits/v1").set({ note: "x" });
  await deps.db.doc("questionnaires/q1").set({ patientUid: uid });
  await deps.db.doc("medications/m1").set({ patientUid: uid });
  await deps.db.doc("ocrJobs/o1").set({ patientUid: uid });
  await deps.db.doc("ocrJobs/o1/candidates/c1").set({ text: "薬" });
  await deps.db.collection("uploads").doc("up1").set({
    patientUid: uid,
    storageBucket: "test-bucket",
    objectPath: `uploads/${uid}/img1.jpg`,
    objectGeneration: "3",
  });
  await deps.db.collection("legalConsents").doc().set({
    subjectUid: uid,
    consentType: "terms_of_service",
    decision: "granted",
  });
  await deps.db.collection("passkeyCredentials").doc().set({ ownerUid: uid });
  await deps.db.collection("facilityMemberships").doc().set({
    userUid: uid,
    facilityId: "f1",
    role: "patient",
  });
  await deps.db.collection("pushDevices").doc("pdv_x").set({
    patientUid: uid,
    token: "tok-x",
    platform: "android",
    status: "active",
    invalidatedReason: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastSeenAt: FieldValue.serverTimestamp(),
  });
  deps.fakeAuthAdmin.users.set(uid, {
    email: "u@example.com",
    password: "x",
    emailVerified: true,
    disabled: false,
  });
}

describe("DeletionWorker.runJob", () => {
  it("全ストアを順序通り削除しジョブを succeeded にする", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps);
    const jobId = await seedJob(deps);

    const r = await new DeletionWorker(deps).runJob(jobId);
    expect(r.outcome).toBe("succeeded");

    const job = await deps.db.doc(`deletionJobs/${jobId}`).get();
    expect(job.data()!.status).toBe("succeeded");
    expect(Object.values(job.data()!.steps)).toEqual(
      Array(8).fill("succeeded"),
    );

    // Firestore 個人データ全消去
    const remaining = deps.memDb
      .listAllPaths()
      .filter((p) => !p.startsWith("deletionJobs/") && !p.startsWith("auditEvents/"));
    expect(remaining).toEqual([]);

    // Storage オブジェクト削除
    expect(deps.fakeStorage.deleted).toEqual([
      { bucket: "test-bucket", path: `uploads/${UID}/img1.jpg`, generation: "3" },
    ]);

    // Auth ユーザー削除
    expect(deps.fakeAuthAdmin.users.has(UID)).toBe(false);

    // 監査イベント記録
    const audits = await deps.db.collection("auditEvents").get();
    expect(audits.size).toBeGreaterThan(0);
  });

  it("期限未到来の scheduled ジョブは not_due", async () => {
    const deps = makeTestDeps();
    const jobId = await seedJob(deps, {
      executeAfterMs: deps.clock.now().getTime() + 3600_000,
    });
    const r = await new DeletionWorker(deps).runJob(jobId);
    expect(r.outcome).toBe("not_due");
    const job = await deps.db.doc(`deletionJobs/${jobId}`).get();
    expect(job.data()!.status).toBe("scheduled");
  });

  it("終端状態のジョブは already_terminal", async () => {
    const deps = makeTestDeps();
    const jobId = await seedJob(deps, { status: "succeeded" });
    const r = await new DeletionWorker(deps).runJob(jobId);
    expect(r.outcome).toBe("already_terminal");
  });

  it("存在しないジョブは not_found", async () => {
    const deps = makeTestDeps();
    const r = await new DeletionWorker(deps).runJob("missing");
    expect(r.outcome).toBe("not_found");
  });

  it("ステップ失敗は failed_retryable → 修復後の再実行で収束する", async () => {
    const deps = makeTestDeps({ deletionJobMaxAttempts: 3 });
    await seedPatientData(deps);
    const jobId = await seedJob(deps);

    // auth 削除を失敗させる
    deps.fakeAuthAdmin.failOn.add("delete");
    const w = new DeletionWorker(deps);
    const r1 = await w.runJob(jobId);
    expect(r1.outcome).toBe("failed_retryable");
    expect(r1.failedStep).toBe("authAccount");

    let job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.status).toBe("scheduled"); // リトライ待ちに戻る
    expect(job.lastErrorCode).toBeTruthy();
    expect(job.attemptCount).toBe(1);
    // バックオフ後の executeAfter が設定される
    expect(
      (job.executeAfter as { toMillis(): number }).toMillis(),
    ).toBeGreaterThan(deps.clock.now().getTime());
    // 成功済みステップは記録済み
    expect(job.steps.intakeSubcollections).toBe("succeeded");
    expect(job.steps.authAccount).toBe("failed");

    // 修復 + 期限到来にして再実行: 成功済みステップはスキップされる
    deps.fakeAuthAdmin.failOn.delete("delete");
    await deps.db.doc(`deletionJobs/${jobId}`).update({
      executeAfter: Timestamp.fromMillis(deps.clock.now().getTime() - 1),
    });
    const r2 = await w.runJob(jobId);
    expect(r2.outcome).toBe("succeeded");
    job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.status).toBe("succeeded");
    expect(deps.fakeAuthAdmin.users.has(UID)).toBe(false);
  });

  it("最大試行回数に達すると failed_terminal", async () => {
    const deps = makeTestDeps({ deletionJobMaxAttempts: 2 });
    await seedPatientData(deps);
    const jobId = await seedJob(deps);
    deps.fakeAuthAdmin.failOn.add("delete");
    const w = new DeletionWorker(deps);

    await w.runJob(jobId); // attempt 1 → retryable
    await deps.db.doc(`deletionJobs/${jobId}`).update({
      executeAfter: Timestamp.fromMillis(deps.clock.now().getTime() - 1),
    });
    const r2 = await w.runJob(jobId); // attempt 2 → terminal
    expect(r2.outcome).toBe("failed_terminal");
    const job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.status).toBe("failed");

    // 終端なので再実行しても already_terminal
    const r3 = await w.runJob(jobId);
    expect(r3.outcome).toBe("already_terminal");
  });
});

describe("DeletionWorker.scanDueJobs", () => {
  it("期限到来の scheduled ジョブのみ実行する", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps, "u-due");
    await seedJob(deps, { uid: "u-due" });
    // 未来のジョブは実行しない
    await seedJob(deps, {
      uid: "u-future",
      executeAfterMs: deps.clock.now().getTime() + 3600_000,
    });

    const r = await new DeletionWorker(deps).scanDueJobs();
    expect(r.scanned).toBe(1);
    expect(r.succeeded).toBe(1);
    expect((await deps.db.doc("accounts/u-due").get()).exists).toBe(false);
  });

  it("期限+24h超過のジョブはアラートを記録してから実行する", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps);
    // アンカーは requestedAt + 猶予30日。それ+24h超過で overdue
    const jobId = await seedJob(deps, {
      requestedAtMs: deps.clock.now().getTime() - 32 * 24 * 3600_000,
      executeAfterMs: deps.clock.now().getTime() - 1000,
    });
    const r = await new DeletionWorker(deps).scanDueJobs();
    expect(r.scanned).toBe(1);
    const job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.overdueAlertedAt).toBeDefined();
    const audits = await deps.db
      .collection("auditEvents")
      .where("action", "==", "DELETION_JOB_OVERDUE")
      .get();
    expect(audits.size).toBe(1);
  });

  it("終端失敗ジョブも当初予定時刻基準で期限超過アラートされる", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps);
    // 申請から猶予+24h超過。リトライで executeAfter が未来へ前進した
    // 状態を模倣（従来のアンカーでは永遠にアラートされない経路）
    const jobId = await seedJob(deps, {
      requestedAtMs: deps.clock.now().getTime() - 32 * 24 * 3600_000,
      executeAfterMs: deps.clock.now().getTime() + 3600_000,
      status: "failed",
      attemptCount: 5,
    });
    const r = await new DeletionWorker(deps).scanDueJobs();
    // failed は再実行対象ではない（already_terminal）がアラートは残る
    expect(
      r.results.filter((x) => x.jobId === jobId && x.outcome !== "already_terminal"),
    ).toHaveLength(0);
    const job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.overdueAlertedAt).toBeDefined();
    const audits = await deps.db
      .collection("auditEvents")
      .where("action", "==", "DELETION_JOB_OVERDUE")
      .get();
    expect(audits.size).toBe(1);
  });
});

describe("放置 running ジョブの回収", () => {
  it("クレーム失効した running ジョブをスキャンで再実行できる", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps);
    const jobId = await seedJob(deps);
    // ワーカー死亡を模倣: running のまま放置
    await deps.db.doc(`deletionJobs/${jobId}`).update({
      status: "running",
      attemptCount: 1,
      lastStartedAt: Timestamp.fromMillis(
        deps.clock.now().getTime() - CLAIM_TTL_MS - 1000,
      ),
    });

    // 直接実行しても回収できる
    const r1 = await new DeletionWorker(deps).runJob(jobId);
    expect(r1.outcome).toBe("succeeded");

    // スキャンでも拾われることを確認（別ケース）
    const deps2 = makeTestDeps();
    await seedPatientData(deps2);
    const jobId2 = await seedJob(deps2);
    await deps2.db.doc(`deletionJobs/${jobId2}`).update({
      status: "running",
      attemptCount: 1,
      lastStartedAt: Timestamp.fromMillis(
        deps2.clock.now().getTime() - CLAIM_TTL_MS - 1000,
      ),
    });
    const scan = await new DeletionWorker(deps2).scanDueJobs();
    expect(scan.scanned).toBe(1);
    expect(scan.succeeded).toBe(1);
  });

  it("クレーム失効前の running ジョブは already_running", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps);
    const jobId = await seedJob(deps);
    await deps.db.doc(`deletionJobs/${jobId}`).update({
      status: "running",
      attemptCount: 1,
      lastStartedAt: Timestamp.fromMillis(deps.clock.now().getTime()),
    });
    const r = await new DeletionWorker(deps).runJob(jobId);
    expect(r.outcome).toBe("already_running");
    // スキャンにも拾われない（重複実行しない）
    const scan = await new DeletionWorker(deps).scanDueJobs();
    expect(scan.executed).toBe(0);
  });

  it("attempt上限の放置 running は claim_abandoned で終端化し失敗監査を残す", async () => {
    const deps = makeTestDeps({ deletionJobMaxAttempts: 2 });
    await seedPatientData(deps);
    const jobId = await seedJob(deps);
    await deps.db.doc(`deletionJobs/${jobId}`).update({
      status: "running",
      attemptCount: 2,
      lastStartedAt: Timestamp.fromMillis(
        deps.clock.now().getTime() - CLAIM_TTL_MS - 1000,
      ),
    });
    const r = await new DeletionWorker(deps).runJob(jobId);
    expect(r.outcome).toBe("already_terminal");
    const job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.status).toBe("failed");
    expect(job.lastErrorCode).toBe("claim_abandoned");
    const audits = await deps.db
      .collection("auditEvents")
      .where("action", "==", "ACCOUNT_DELETION_FAILED")
      .get();
    expect(audits.size).toBe(1);
    const ev = audits.docs[0]!.data()!;
    expect(ev.outcome).toBe("failed_terminal");
    expect(ev.details?.errorClass).toBe("claim_abandoned");
    expect(ev.resourceIdHash).not.toBe(jobId);
  });
});

describe("Storage オブジェクト削除の失敗伝播", () => {
  it("削除失敗は参照を保持したままリトライ対象になり、修復後に収束する", async () => {
    const deps = makeTestDeps({ deletionJobMaxAttempts: 3 });
    await seedPatientData(deps);
    const jobId = await seedJob(deps);
    deps.fakeStorage.failOn.add("test-bucket/uploads/u-worker-1/img1.jpg");

    const w = new DeletionWorker(deps);
    const r1 = await w.runJob(jobId);
    expect(r1.outcome).toBe("failed_retryable");
    expect(r1.failedStep).toBe("storageObjects");

    let job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    // 失敗したオブジェクト参照がジョブに保持されている
    expect(job.pendingStorageObjects).toEqual([
      { bucket: "test-bucket", path: "uploads/u-worker-1/img1.jpg", generation: "3" },
    ]);

    // 修復して再実行: 退避済み参照だけを再試行して収束
    deps.fakeStorage.failOn.clear();
    await deps.db.doc(`deletionJobs/${jobId}`).update({
      executeAfter: Timestamp.fromMillis(deps.clock.now().getTime() - 1),
    });
    const r2 = await w.runJob(jobId);
    expect(r2.outcome).toBe("succeeded");
    job = (await deps.db.doc(`deletionJobs/${jobId}`).get()).data()!;
    expect(job.pendingStorageObjects).toBeUndefined();
    expect(deps.fakeStorage.deleted).toHaveLength(1);
  });

  it("uploads ステップは参照を永続化してからドキュメントを削除する", async () => {
    const deps = makeTestDeps();
    await seedPatientData(deps);
    const jobId = await seedJob(deps);
    const r = await new DeletionWorker(deps).runJob(jobId);
    expect(r.outcome).toBe("succeeded");
    // uploads ドキュメントは削除済み・Storage オブジェクトも削除済み
    const uploads = await deps.db
      .collection("uploads")
      .where("patientUid", "==", UID)
      .get();
    expect(uploads.empty).toBe(true);
    expect(deps.fakeStorage.deleted).toEqual([
      { bucket: "test-bucket", path: "uploads/u-worker-1/img1.jpg", generation: "3" },
    ]);
  });
});
