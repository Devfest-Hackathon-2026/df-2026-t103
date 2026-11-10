import { describe, expect, it } from "vitest";
import {
  cancelDeletion,
  getDeletionStatus,
  requestDeletion,
} from "../../src/services/deletion.js";
import { type ApiError } from "../../src/lib/errors.js";
import { makeTestDeps } from "../helpers/deps.js";
import { seedAccount } from "../helpers/app.js";

const UID = "u-del-1";

async function request(deps: ReturnType<typeof makeTestDeps>, key = "k1") {
  return requestDeletion(deps, {
    uid: UID,
    idempotencyKey: key,
    requestId: "req-1",
  });
}

describe("requestDeletion", () => {
  it("30日後の削除ジョブを登録しアカウントを pending_deletion にする", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    const r = await request(deps);
    expect(r.status).toBe("pending_deletion");
    expect(r.canCancel).toBe(true);
    expect(r.jobStatus).toBe("scheduled");
    const expectedMs =
      deps.clock.now().getTime() + 30 * 24 * 3600_000;
    expect(new Date(r.scheduledForDeletionAt!).getTime()).toBe(expectedMs);

    const account = await deps.db.doc(`accounts/${UID}`).get();
    expect(account.data()!.accountStatus).toBe("pending_deletion");

    const jobs = await deps.db.collection("deletionJobs").get();
    expect(jobs.size).toBe(1);
    const job = jobs.docs[0]!.data();
    expect(job.subjectUid).toBe(UID);
    expect(job.status).toBe("scheduled");
    expect(Object.values(job.steps)).toHaveLength(8);
  });

  it("同一 Idempotency-Key の再送は結果を再生しジョブを増やさない", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    await request(deps, "k1");
    await request(deps, "k1");
    const jobs = await deps.db.collection("deletionJobs").get();
    expect(jobs.size).toBe(1);
  });

  it("別キーでの二重申請もジョブを増やさず現在状態を返す", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    await request(deps, "k1");
    const r = await request(deps, "k2");
    expect(r.status).toBe("pending_deletion");
    const jobs = await deps.db.collection("deletionJobs").get();
    expect(jobs.size).toBe(1);
  });

  it("アカウント無しは 403", async () => {
    const deps = makeTestDeps();
    try {
      await request(deps);
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(403);
    }
  });
});

describe("cancelDeletion", () => {
  it("保留期間内なら取消できアカウント状態が復元される", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    await request(deps);
    const r = await cancelDeletion(deps, {
      uid: UID,
      idempotencyKey: "kc1",
      requestId: "req-2",
    });
    expect(r.status).toBe("cancelled");

    const account = await deps.db.doc(`accounts/${UID}`).get();
    expect(account.data()!.accountStatus).toBe("active");
    expect(account.data()!.deletionJobId).toBeUndefined();

    const jobs = await deps.db.collection("deletionJobs").get();
    expect(jobs.docs[0]!.data().status).toBe("cancelled");
  });

  it("申請が無ければ 412", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    try {
      await cancelDeletion(deps, {
        uid: UID,
        idempotencyKey: "kc1",
        requestId: "r",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(412);
    }
  });

  it("期限経過後は 412 で取消不可", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    await request(deps);
    deps.clock.advanceMs(31 * 24 * 3600_000);
    try {
      await cancelDeletion(deps, {
        uid: UID,
        idempotencyKey: "kc1",
        requestId: "r",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(412);
    }
  });

  it("実行開始後は 412 で取消不可", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    await request(deps);
    const jobs = await deps.db.collection("deletionJobs").get();
    await jobs.docs[0]!.ref.update({ status: "running" });
    try {
      await cancelDeletion(deps, {
        uid: UID,
        idempotencyKey: "kc1",
        requestId: "r",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(412);
    }
  });
});

describe("getDeletionStatus", () => {
  it("未申請は status=none", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    const r = await getDeletionStatus(deps, UID);
    expect(r.status).toBe("none");
  });

  it("申請中は canCancel=true の pending_deletion", async () => {
    const deps = makeTestDeps();
    await seedAccount(deps, UID);
    await request(deps);
    const r = await getDeletionStatus(deps, UID);
    expect(r.status).toBe("pending_deletion");
    expect(r.canCancel).toBe(true);
  });
});
