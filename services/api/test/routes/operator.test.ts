import { describe, expect, it } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { authHeader, buildTestApp } from "../helpers/app.js";
import type { AuditEventDoc, FacilityDoc } from "../../src/domain/firestoreDocs.js";
import { encodeOpaqueCursor } from "../../src/lib/opaqueCursor.js";
import { hmacSha256Hex } from "../../src/lib/hash.js";

const OP = "op-admin-1";
const FAC = "fac-op-1";

async function setup(opts: { operatorRole?: string } = {}) {
  const deps = makeTestDeps();
  const app = buildTestApp(deps);
  await app.ready();
  await deps.db.doc("facilityMemberships/op").set({
    userUid: OP,
    facilityId: "platform",
    role: opts.operatorRole ?? "platform_security_admin",
    status: "active",
  });
  return { app, deps };
}

async function seedFacility(
  deps: TestDeps,
  opts: {
    facilityId?: string;
    verificationStatus?: string;
    receivingEnabled?: boolean;
  } = {},
): Promise<string> {
  const id = opts.facilityId ?? FAC;
  const ts = FieldValue.serverTimestamp();
  await deps.db.doc(`facilities/${id}`).set({
    facilityId: id,
    legalName: "運営テスト病院",
    displayName: "運営テスト病院",
    verificationStatus: opts.verificationStatus ?? "pending",
    receivingEnabled: opts.receivingEnabled ?? false,
    serviceAgreementVersion: "v1",
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

const VALID_CHECKS = {
  existence: true,
  applicant: true,
  receiverContact: true,
  location: true,
};

async function auditActions(deps: TestDeps, action: string) {
  const snap = await deps.db.collection("auditEvents").get();
  return snap.docs
    .map((d) => d.data() as AuditEventDoc)
    .filter((e) => e.action === action);
}

describe("POST /v1/operator/facilities/:facilityId/verify", () => {
  const url = `/v1/operator/facilities/${FAC}/verify`;

  it("未認証401・非運営403・存在しない施設404", async () => {
    const { app } = await setup();
    const body = {
      checks: VALID_CHECKS,
      verificationRecordId: "rec-1",
    };
    expect(
      (await app.inject({ method: "POST", url, payload: body })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authHeader("not-operator"),
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authHeader(OP),
          payload: body,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("検証項目が1つでも false なら400、recordId必須", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps);
    const bad = await app.inject({
      method: "POST",
      url,
      headers: authHeader(OP),
      payload: {
        checks: { ...VALID_CHECKS, location: false },
        verificationRecordId: "rec-1",
      },
    });
    expect(bad.statusCode).toBe(400);
    const noRecord = await app.inject({
      method: "POST",
      url,
      headers: authHeader(OP),
      payload: { checks: VALID_CHECKS },
    });
    expect(noRecord.statusCode).toBe(400);
    // 失敗しても verified にはなっていない
    const fac = (await deps.db.doc(`facilities/${FAC}`).get())
      .data() as FacilityDoc;
    expect(fac.verificationStatus).toBe("pending");
    await app.close();
  });

  it("pending → verified: 証跡doc・verifiedAt・recordId・監査を記録する", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps);

    const res = await app.inject({
      method: "POST",
      url,
      headers: authHeader(OP),
      payload: {
        checks: VALID_CHECKS,
        verificationRecordId: "medical-license-123",
        note: "登記簿謄本で確認",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verificationStatus).toBe("verified");

    const fac = (await deps.db.doc(`facilities/${FAC}`).get())
      .data() as FacilityDoc;
    expect(fac.verificationStatus).toBe("verified");
    expect(fac.verifiedAt).toBeTruthy();
    expect(fac.verificationRecordId).toBe("medical-license-123");

    // FR-H04 検証証跡
    const recs = await deps.db.collection("facilityVerificationRecords").get();
    expect(recs.size).toBe(1);
    const rec = recs.docs[0]!.data() as Record<string, unknown>;
    expect(rec["facilityId"]).toBe(FAC);
    expect(rec["verifierUid"]).toBe(OP);
    expect(rec["checks"]).toEqual(VALID_CHECKS);
    expect(rec["verificationRecordId"]).toBe("medical-license-123");
    expect(rec["note"]).toBe("登記簿謄本で確認");

    const events = await auditActions(deps, "FACILITY_VERIFIED");
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe("platform");
    expect(events[0]!.details).toEqual({
      from: "pending",
      recordRefHash: expect.any(String),
    });
    expect(JSON.stringify(events)).not.toContain("medical-license-123");
    expect(JSON.stringify(events)).not.toContain("登記簿謄本で確認");
    // 監査に生の施設ID/運営UIDを含めない
    expect(events[0]!.actorUidHash).not.toBe(OP);
    expect(events[0]!.resourceIdHash).not.toBe(FAC);
    await app.close();
  });

  it("既承認は409、suspended/rejectedからは再承認できる", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps, { verificationStatus: "suspended" });
    const body = { checks: VALID_CHECKS, verificationRecordId: "rec-2" };
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authHeader(OP),
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    // 2回目（verified）は409
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authHeader(OP),
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    // facilityId の文字種違反（doc パス分断）は400
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/operator/facilities/bad%20id/verify",
          headers: authHeader(OP),
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("再認証が古い場合は403 REAUTH_REQUIRED", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps);
    deps.fakeAuth.authTimeByToken.set(`token-${OP}`, 1);
    const res = await app.inject({
      method: "POST",
      url,
      headers: authHeader(OP),
      payload: { checks: VALID_CHECKS, verificationRecordId: "r" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("REAUTH_REQUIRED");
    await app.close();
  });
});

describe("POST /v1/operator/facilities/:facilityId/disable", () => {
  const url = `/v1/operator/facilities/${FAC}/disable`;

  it("受付を停止し理由と時刻を記録、監査を発行する", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps, {
      verificationStatus: "verified",
      receivingEnabled: true,
    });

    const res = await app.inject({
      method: "POST",
      url,
      headers: authHeader(OP),
      payload: { reason: "緊急: 不正申請の疑い" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().receivingEnabled).toBe(false);

    const fac = (await deps.db.doc(`facilities/${FAC}`).get())
      .data() as FacilityDoc;
    expect(fac.receivingEnabled).toBe(false);
    expect(fac.receivingDisabledReason).toBe("緊急: 不正申請の疑い");
    expect(fac.receivingDisabledAt).toBeTruthy();
    // 停止は審査状態を変更しない（verified のまま）
    expect(fac.verificationStatus).toBe("verified");

    const events = await auditActions(deps, "FACILITY_RECEIVING_DISABLED");
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe("platform");
    await app.close();
  });

  it("既停止の再呼出は冪等に成功し監査を重複発行しない", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps, {
      verificationStatus: "verified",
      receivingEnabled: false,
    });
    const res = await app.inject({
      method: "POST",
      url,
      headers: authHeader(OP),
      payload: { reason: "再送" },
    });
    expect(res.statusCode).toBe(200);
    expect(await auditActions(deps, "FACILITY_RECEIVING_DISABLED")).toHaveLength(
      0,
    );
    // 理由が既存値を上書きしない
    const fac = (await deps.db.doc(`facilities/${FAC}`).get())
      .data() as FacilityDoc;
    expect(fac.receivingDisabledReason).toBeUndefined();
    await app.close();
  });

  it("非運営403・404・reason必須400", async () => {
    const { app, deps } = await setup();
    await seedFacility(deps, {
      verificationStatus: "verified",
      receivingEnabled: true,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authHeader("not-operator"),
          payload: { reason: "x" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/operator/facilities/fac-missing/disable",
          headers: authHeader(OP),
          payload: { reason: "x" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authHeader(OP),
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});

describe("GET /v1/operator/job-failures", () => {
  /** 現行スキームの擬名ジョブID（oj_+64hex）。 */
  const oj = (c: string) => `oj_${c.padEnd(64, "0")}`;

  async function seedFailedJobs(deps: TestDeps) {
    // OCR: failed ×4（うち1件は旧形式 docId=uploadId）, succeeded ×1
    for (let i = 1; i <= 3; i++) {
      await deps.db.doc(`ocrJobs/${oj(String(i).padStart(4, "0"))}`).set({
        uploadId: `upload-${i}`,
        patientUid: "u-patient-secret",
        status: "failed",
        engine: "dummy",
        attempt: i,
        errorCode: "image_unclear",
        candidates: [],
        dispatchState: "enqueued",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: Timestamp.fromMillis(1000 + i),
      });
    }
    // 旧形式: doc ID が uploadId そのもの（ハッシュ化以前のジョブ）
    await deps.db.doc("ocrJobs/upload-legacy-1").set({
      uploadId: "upload-legacy-1",
      patientUid: "u-patient-secret",
      status: "failed",
      engine: "dummy",
      attempt: 2,
      errorCode: "engine_unavailable",
      candidates: [],
      dispatchState: "enqueued",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: Timestamp.fromMillis(500),
    });
    await deps.db.doc(`ocrJobs/${oj("f")}`).set({
      uploadId: "upload-ok",
      patientUid: "u-patient-secret",
      status: "succeeded",
      engine: "dummy",
      attempt: 1,
      errorCode: null,
      candidates: [],
      dispatchState: "enqueued",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: Timestamp.fromMillis(9999),
    });
    // deletion: failed ×1
    await deps.db.doc("deletionJobs/job-del-1").set({
      subjectUid: "u-subject-secret",
      requestedAt: Timestamp.fromMillis(5000),
      executeAfter: Timestamp.fromMillis(6000),
      status: "failed",
      steps: {},
      attemptCount: 2,
      lastErrorCode: "storage_delete_failed",
      lastStartedAt: Timestamp.fromMillis(7000),
    });
  }

  it("type=ocr で失敗ジョブのみ返し、PII識別子を含めない", async () => {
    const { app, deps } = await setup();
    await seedFailedJobs(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/operator/job-failures?type=ocr&limit=10",
      headers: authHeader(OP),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    for (const it of items) {
      expect(it["type"]).toBe("ocr");
      // FR-O04: 患者UID/件名UID/アップロードIDを含めない。
      // 旧形式doc(=uploadIdがdoc ID)の jobId も擬名化されて "upload-" を漏らさない
      const json = JSON.stringify(it);
      expect(json).not.toContain("u-patient-secret");
      expect(json).not.toContain("u-subject-secret");
      expect(json).not.toContain("upload-");
      expect(it["jobId"]).toMatch(/^oj_[0-9a-f]{64}$/);
    }
    // updatedAt 降順（oj("0003") が先頭、レガシー(500ms)が末尾）
    expect(items[0]!["jobId"]).toBe(oj("0003"));
    expect(items[3]!["failureCode"]).toBe("engine_unavailable");

    const events = await auditActions(deps, "JOB_FAILURES_LISTED");
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toEqual({ type: "ocr" });
    await app.close();
  });

  it("type=deletion・カーソルページング・権限/バリデーション", async () => {
    const { app, deps } = await setup();
    await seedFailedJobs(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/operator/job-failures?type=deletion",
      headers: authHeader(OP),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "deletion",
      jobId: "job-del-1",
      failureCode: "storage_delete_failed",
      attempts: 2,
    });
    expect(JSON.stringify(items[0])).not.toContain("u-subject-secret");

    // ページング（nextCursor は内部IDを含まない不透明トークン）
    const p1 = await app.inject({
      method: "GET",
      url: "/v1/operator/job-failures?type=ocr&limit=2",
      headers: authHeader(OP),
    });
    const j1 = p1.json();
    expect(j1.items).toHaveLength(2);
    expect(j1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const p2 = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&limit=2&cursor=${j1.nextCursor}`,
      headers: authHeader(OP),
    });
    const j2 = p2.json();
    expect(j2.items).toHaveLength(2);
    expect(j2.nextCursor).toBeNull();
    // 2ページ目は残り2件（updatedAt降順の続き）。レガシーdocは
    // 同一HMACスキームの擬名IDで返る
    expect(j2.items.map((i: { jobId: string }) => i.jobId)).toEqual([
      oj("0001"),
      `oj_${hmacSha256Hex(deps.config.hmacSecret, "ocr-job:upload-legacy-1")}`,
    ]);

    // 権限とバリデーション
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/operator/job-failures?type=ocr",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/operator/job-failures?type=ocr",
          headers: authHeader("not-operator"),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/operator/job-failures?type=bad",
          headers: authHeader(OP),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/operator/job-failures?type=ocr&cursor=bad/cursor",
          headers: authHeader(OP),
        })
      ).statusCode,
    ).toBe(400);
    // 復号不能カーソル・非失敗doc・他コレクションは空ページ
    const garbage = await app.inject({
      method: "GET",
      url: "/v1/operator/job-failures?type=ocr&cursor=not-a-real-cursor",
      headers: authHeader(OP),
    });
    expect(garbage.json().items).toEqual([]);
    const notFailed = encodeOpaqueCursor(
      deps.config.hmacSecret,
      `ocrJobs/${oj("f")}`,
    );
    const empty = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&cursor=${notFailed}`,
      headers: authHeader(OP),
    });
    expect(empty.json().items).toEqual([]);
    const foreign = encodeOpaqueCursor(
      deps.config.hmacSecret,
      "deletionJobs/job-del-1",
    );
    const cross = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&cursor=${foreign}`,
      headers: authHeader(OP),
    });
    expect(cross.json().items).toEqual([]);
    await app.close();
  });

  it("カーソル異常系: 改竄・削除済み・ソートキー欠落・別鍵・deletion往復", async () => {
    const { app, deps } = await setup();
    await seedFailedJobs(deps);

    // 改竄トークン（文字種は満たすがGCM認証失敗）→ 空ページ
    const good = encodeOpaqueCursor(
      deps.config.hmacSecret,
      `ocrJobs/${oj("0003")}`,
    );
    // 末尾はbase64のパディングビットを含むため、中間の1文字を改竄する
    const mid = Math.floor(good.length / 2);
    const tampered = `${good.slice(0, mid)}${good[mid] === "A" ? "B" : "A"}${good.slice(mid + 1)}`;
    const t = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&cursor=${tampered}`,
      headers: authHeader(OP),
    });
    expect(t.json().items).toEqual([]);

    // 削除済みdoc → 空ページ
    const gone = encodeOpaqueCursor(
      deps.config.hmacSecret,
      "ocrJobs/oj_deleted000",
    );
    const g = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&cursor=${gone}`,
      headers: authHeader(OP),
    });
    expect(g.json().items).toEqual([]);

    // failed だがソートキー欠落のdoc → 空ページ
    await deps.db.doc("ocrJobs/oj_notsortkey").set({
      uploadId: "upload-x",
      patientUid: "u-patient-secret",
      status: "failed",
      engine: "dummy",
      attempt: 1,
      errorCode: "image_unclear",
      candidates: [],
      dispatchState: "enqueued",
      createdAt: FieldValue.serverTimestamp(),
    });
    const noKey = encodeOpaqueCursor(
      deps.config.hmacSecret,
      "ocrJobs/oj_notsortkey",
    );
    const k = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&cursor=${noKey}`,
      headers: authHeader(OP),
    });
    expect(k.json().items).toEqual([]);

    // 別鍵で暗号化 → 復号失敗で空ページ
    const wrongKey = encodeOpaqueCursor(
      "different-secret",
      `ocrJobs/${oj("0003")}`,
    );
    const w = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=ocr&cursor=${wrongKey}`,
      headers: authHeader(OP),
    });
    expect(w.json().items).toEqual([]);

    // deletion のカーソル往復（ソートキー: requestedAt）
    await deps.db.doc("deletionJobs/job-del-2").set({
      subjectUid: "u-subject-secret",
      requestedAt: Timestamp.fromMillis(4000),
      status: "failed",
      attemptCount: 1,
      lastErrorCode: "firestore_delete_failed",
      lastStartedAt: Timestamp.fromMillis(4100),
    });
    const d1 = await app.inject({
      method: "GET",
      url: "/v1/operator/job-failures?type=deletion&limit=1",
      headers: authHeader(OP),
    });
    const dj1 = d1.json();
    expect(dj1.items).toHaveLength(1);
    expect(dj1.items[0].jobId).toBe("job-del-1");
    expect(dj1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const d2 = await app.inject({
      method: "GET",
      url: `/v1/operator/job-failures?type=deletion&limit=1&cursor=${dj1.nextCursor}`,
      headers: authHeader(OP),
    });
    const dj2 = d2.json();
    expect(dj2.items.map((i: { jobId: string }) => i.jobId)).toEqual([
      "job-del-2",
    ]);
    expect(dj2.nextCursor).toBeNull();
    await app.close();
  });
});
