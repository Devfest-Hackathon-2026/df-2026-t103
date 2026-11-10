import { describe, expect, it } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { FastifyInstance } from "fastify";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import type { DeliveryDoc } from "../../src/domain/firestoreDocs.js";

const FACILITY_A = "fac-a";
const FACILITY_B = "fac-b";
const STAFF_A = "staff-a-1";
const STAFF_B = "staff-b-1";
const PATIENT = "patient-1";

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  await seedAccount(deps, STAFF_A);
  await seedCurrentConsents(deps, STAFF_A);
  await seedAccount(deps, STAFF_B);
  await seedCurrentConsents(deps, STAFF_B);
  return { deps, app: buildTestApp(deps) };
}

/** 施設メンバーシップを直接シードする。 */
async function seedMembership(
  deps: TestDeps,
  uid: string,
  facilityId: string,
  role: "facility_staff" | "facility_clinician" | "facility_admin" = "facility_staff",
): Promise<void> {
  await deps.db.collection("facilityMemberships").doc().set({
    userUid: uid,
    facilityId,
    role,
    status: "active",
    mfaEnforced: false,
    createdAt: FieldValue.serverTimestamp(),
    revokedAt: null,
  });
}

/** テスト用施設を直接シードする。 */
async function seedFacility(
  deps: TestDeps,
  facilityId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const now = Timestamp.fromDate(new Date("2026-01-01T00:00:00Z"));
  await deps.db.doc(`facilities/${facilityId}`).set({
    facilityId,
    legalName: "医療法人テスト会テスト病院",
    displayName: "テスト病院",
    address: { formatted: "東京都千代田区1-1-1" },
    verificationStatus: "verified",
    receivingEnabled: true,
    serviceAgreementVersion: "v1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

/** テスト用配送物を直接シードする。 */
async function seedDelivery(
  deps: TestDeps,
  id: string,
  facilityId: string,
  overrides: Partial<DeliveryDoc> = {},
): Promise<string> {
  const now = Timestamp.fromDate(new Date("2026-01-01T00:00:00Z"));
  const doc: DeliveryDoc = {
    senderUid: PATIENT,
    facilityId,
    questionnaireId: "qn-1",
    questionnaireRevisionId: "rev-1",
    consentId: "consent-1",
    shareScope: { includeProfile: true, includeConfirmedMedications: false, includePrescriptionImages: false },
    patientIdentitySnapshot: { familyName: "山田", givenName: "太郎" },
    questionnaireSnapshot: { chiefComplaint: "頭痛" },
    snapshotSha256: "abc123",
    status: "delivered",
    idempotencyKeyHash: "key-hash-1",
    facilityRetentionPolicyVersion: "v1",
    createdAt: now,
    deliveredAt: now,
    ...overrides,
  };
  await deps.db.doc(`deliveries/${id}`).set(doc);
  return id;
}

describe("hospital receive routes (#18, API-031〜033)", () => {
  describe("GET /v1/hospitals/:facilityId/deliveries", () => {
    it("自院のdeliveriesのみ返す", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-1", FACILITY_A);
      await seedDelivery(deps, "d-2", FACILITY_B);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        deliveries: Array<{ deliveryId: string; facilityId: string }>;
        nextCursor: string | null;
      };
      expect(body.deliveries).toHaveLength(1);
      expect(body.deliveries[0]!.deliveryId).toBe("d-1");
      expect(body.deliveries[0]!.facilityId).toBe(FACILITY_A);
      expect(body.nextCursor).toBeNull();
    });

    it("他院メンバーでは403", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_B, FACILITY_B);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries`,
        headers: authHeader(STAFF_B),
      });
      expect(res.statusCode).toBe(403);
    });

    it("未認証は401", async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("senderUid は一覧に含まれない", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-3", FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: Array<Record<string, unknown>> };
      expect(body.deliveries[0]).not.toHaveProperty("senderUid");
    });

    it("nextCursor で次ページを取得できる", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      const base = Date.parse("2026-01-10T00:00:00Z");
      for (let i = 0; i < 3; i++) {
        await seedDelivery(deps, `d-page-${i}`, FACILITY_A, {
          deliveredAt: Timestamp.fromMillis(base - i * 1000),
          createdAt: Timestamp.fromMillis(base - i * 1000),
        });
      }

      const page1 = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?limit=2`,
        headers: authHeader(STAFF_A),
      });
      expect(page1.statusCode).toBe(200);
      const p1 = page1.json() as {
        deliveries: Array<{ deliveryId: string }>;
        nextCursor: string | null;
      };
      expect(p1.deliveries.map((d) => d.deliveryId)).toEqual([
        "d-page-0",
        "d-page-1",
      ]);
      expect(p1.nextCursor).toBe("d-page-1");

      const page2 = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?limit=2&cursor=${p1.nextCursor}`,
        headers: authHeader(STAFF_A),
      });
      expect(page2.statusCode).toBe(200);
      const p2 = page2.json() as {
        deliveries: Array<{ deliveryId: string }>;
        nextCursor: string | null;
      };
      expect(p2.deliveries.map((d) => d.deliveryId)).toEqual(["d-page-2"]);
      expect(p2.nextCursor).toBeNull();
    });

    it("patientDisplayName を一覧に返す（senderUid は返さない）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-name", FACILITY_A, {
        patientDisplayName: "山田 太郎",
      });
      await seedDelivery(deps, "d-no-name", FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        deliveries: Array<{ deliveryId: string; patientDisplayName: string | null }>;
      };
      const named = body.deliveries.find((d) => d.deliveryId === "d-name");
      const unnamed = body.deliveries.find((d) => d.deliveryId === "d-no-name");
      expect(named?.patientDisplayName).toBe("山田 太郎");
      expect(unnamed?.patientDisplayName).toBeNull();
    });

    it("status で絞り込める", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-del", FACILITY_A);
      await seedDelivery(deps, "d-ack", FACILITY_A, {
        status: "acknowledged",
        acknowledgedAt: Timestamp.fromDate(new Date("2026-01-02T00:00:00Z")),
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?status=acknowledged`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: Array<{ deliveryId: string }> };
      expect(body.deliveries.map((d) => d.deliveryId)).toEqual(["d-ack"]);
    });

    it("q は患者表示名の前方一致で自院スコープに限定される", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-yamada", FACILITY_A, {
        patientDisplayName: "山田 太郎",
      });
      await seedDelivery(deps, "d-sato", FACILITY_A, {
        patientDisplayName: "佐藤 花子",
      });
      // 他院の同名患者は混ざらない
      await seedDelivery(deps, "d-b-yamada", FACILITY_B, {
        patientDisplayName: "山田 次郎",
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?q=${encodeURIComponent("山田")}`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: Array<{ deliveryId: string }> };
      expect(body.deliveries.map((d) => d.deliveryId)).toEqual(["d-yamada"]);
    });

    it("他院のカーソルは空ページを返す", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-b-cursor", FACILITY_B);
      await seedDelivery(deps, "d-a", FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?cursor=d-b-cursor`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: unknown[] };
      expect(body.deliveries).toHaveLength(0);
    });

    it("q 検索中に表示名を持たないカーソルは空ページを返す（範囲外カーソルの500防止）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      // patientDisplayName なし（非同意/旧データ相当）
      await seedDelivery(deps, "d-unnamed", FACILITY_A);
      await seedDelivery(deps, "d-yamada2", FACILITY_A, {
        patientDisplayName: "山田 太郎",
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?q=${encodeURIComponent("山田")}&cursor=d-unnamed`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: unknown[] };
      expect(body.deliveries).toHaveLength(0);
    });

    it("status と q を併用できる", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-y-ack", FACILITY_A, {
        patientDisplayName: "山田 太郎",
        status: "acknowledged",
        acknowledgedAt: Timestamp.fromDate(new Date("2026-01-02T00:00:00Z")),
      });
      await seedDelivery(deps, "d-y-del", FACILITY_A, {
        patientDisplayName: "山田 次郎",
      });
      await seedDelivery(deps, "d-s-ack", FACILITY_A, {
        patientDisplayName: "佐藤 花子",
        status: "acknowledged",
        acknowledgedAt: Timestamp.fromDate(new Date("2026-01-02T00:00:00Z")),
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?status=acknowledged&q=${encodeURIComponent("山田")}`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: Array<{ deliveryId: string }> };
      expect(body.deliveries.map((d) => d.deliveryId)).toEqual(["d-y-ack"]);
    });

    it("失効したカーソルは空ページを返す", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-any", FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries?cursor=nonexistent`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        deliveries: unknown[];
        nextCursor: string | null;
      };
      expect(body.deliveries).toHaveLength(0);
      expect(body.nextCursor).toBeNull();
    });
  });

  describe("GET /v1/hospitals/:facilityId/deliveries/:deliveryId", () => {
    it("自院のdelivery詳細を返す", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-detail-1", FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-detail-1`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        deliveryId: string;
        status: string;
        snapshotSha256: string;
        questionnaireSnapshot: Record<string, unknown>;
      };
      expect(body.deliveryId).toBe("d-detail-1");
      expect(body.status).toBe("delivered");
      expect(body.snapshotSha256).toBe("abc123");
      expect(body.questionnaireSnapshot).toMatchObject({ chiefComplaint: "頭痛" });
    });

    it("IDOR: 他院のdeliveryはdeliveryId正しくても404（E2E-004）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedMembership(deps, STAFF_B, FACILITY_B);
      await seedDelivery(deps, "d-other", FACILITY_B);

      // STAFF_A が FACILITY_A としてアクセスするが実際は FACILITY_B のデータ
      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-other`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(404);
    });

    it("存在しないdeliveryは404", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/nonexistent`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(404);
    });

    it("DELIVERY_VIEWED 監査イベントが記録される", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-audit", FACILITY_A);

      await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-audit`,
        headers: authHeader(STAFF_A),
      });

      const audits = await deps.db.collection("auditEvents").get();
      const viewEvents = audits.docs
        .map((d) => d.data())
        .filter((e) => e["action"] === "DELIVERY_VIEWED");
      expect(viewEvents.length).toBeGreaterThanOrEqual(1);
      expect(viewEvents[0]!["facilityId"]).toBe(FACILITY_A);
      expect(viewEvents[0]!["decision"]).toBe("allow");
    });

    it("他院アクセス拒否の監査イベントが記録される（E2E-004）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-deny", FACILITY_B);

      await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-deny`,
        headers: authHeader(STAFF_A),
      });

      const audits = await deps.db.collection("auditEvents").get();
      const denyEvents = audits.docs
        .map((d) => d.data())
        .filter((e) => e["action"] === "DELIVERY_VIEWED" && e["decision"] === "deny");
      expect(denyEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("POST /v1/hospitals/:facilityId/deliveries/:deliveryId/acknowledge", () => {
    it("受領確認が成功しstatus=acknowledgedになる", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-ack-1", FACILITY_A);

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-1/acknowledge`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        deliveryId: string;
        status: string;
        acknowledgedAt: string;
      };
      expect(body.deliveryId).toBe("d-ack-1");
      expect(body.status).toBe("acknowledged");
      expect(body.acknowledgedAt).toBeTruthy();

      const snap = await deps.db.doc("deliveries/d-ack-1").get();
      expect(snap.data()!["status"]).toBe("acknowledged");
    });

    it("二重acknowledge は冪等に成功する（FR-H10）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-ack-2", FACILITY_A, {
        status: "acknowledged",
        acknowledgedAt: Timestamp.fromDate(new Date()),
      });

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-2/acknowledge`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe("acknowledged");
    });

    it("受領確認で DELIVERY_ACKNOWLEDGED 監査が記録される", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-ack-audit", FACILITY_A);

      await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-audit/acknowledge`,
        headers: authHeader(STAFF_A),
      });

      const audits = await deps.db.collection("auditEvents").get();
      const events = audits.docs
        .map((d) => d.data())
        .filter((e) => e["action"] === "DELIVERY_ACKNOWLEDGED");
      expect(events).toHaveLength(1);
      expect(events[0]!["decision"]).toBe("allow");
      expect(events[0]!["facilityId"]).toBe(FACILITY_A);
      // 生IDは保存しない
      expect(events[0]!["resourceIdHash"]).not.toBe("d-ack-audit");
    });

    it("冪等な再受領は元の acknowledgedAt を返し監査を重複発行しない", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      const originalAck = Timestamp.fromDate(new Date("2026-01-02T03:04:05Z"));
      await seedDelivery(deps, "d-ack-idem", FACILITY_A, {
        status: "acknowledged",
        acknowledgedAt: originalAck,
      });

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-idem/acknowledge`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { acknowledgedAt: string };
      expect(body.acknowledgedAt).toBe("2026-01-02T03:04:05.000Z");

      const audits = await deps.db.collection("auditEvents").get();
      const events = audits.docs
        .map((d) => d.data())
        .filter((e) => e["action"] === "DELIVERY_ACKNOWLEDGED");
      expect(events).toHaveLength(0);
    });

    it("終端状態（revoked/failed）への受領確認は409で監査も発行しない", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-ack-rev", FACILITY_A, { status: "revoked" });

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-rev/acknowledge`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(409);

      // 終端状態が acknowledged に書き換わっていないこと
      const snap = await deps.db.doc("deliveries/d-ack-rev").get();
      expect(snap.data()!["status"]).toBe("revoked");
      const audits = await deps.db.collection("auditEvents").get();
      const events = audits.docs
        .map((d) => d.data())
        .filter((e) => e["action"] === "DELIVERY_ACKNOWLEDGED");
      expect(events).toHaveLength(0);
    });

    it("他院deliveryの受領確認拒否も deny 監査が記録される（E2E-004）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-ack-deny", FACILITY_B);

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-deny/acknowledge`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(404);

      const audits = await deps.db.collection("auditEvents").get();
      const events = audits.docs
        .map((d) => d.data())
        .filter(
          (e) => e["action"] === "DELIVERY_ACKNOWLEDGED" && e["decision"] === "deny",
        );
      expect(events).toHaveLength(1);
    });

    it("他院のdeliveryは404", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A);
      await seedDelivery(deps, "d-ack-other", FACILITY_B);

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-other/acknowledge`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(404);
    });

    it("他院メンバーでは403", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_B, FACILITY_B);
      await seedDelivery(deps, "d-ack-403", FACILITY_A);

      const res = await app.inject({
        method: "POST",
        url: `/v1/hospitals/${FACILITY_A}/deliveries/d-ack-403/acknowledge`,
        headers: authHeader(STAFF_B),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET/PATCH /v1/hospitals/:facilityId/settings (H-006)", () => {
    it("施設管理者は設定を参照できる", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A);

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.legalName).toBe("医療法人テスト会テスト病院");
      expect(body.displayName).toBe("テスト病院");
      expect(body.formattedAddress).toBe("東京都千代田区1-1-1");
      expect(body.verificationStatus).toBe("verified");
      expect(body.receivingEnabled).toBe(true);
    });

    it("施設自身が停止した場合は停止理由を参照できる", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A, {
        receivingEnabled: false,
        receivingDisabledBy: "staff",
        receivingDisabledReason: "年末年始休診",
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().receivingDisabledReason).toBe("年末年始休診");
    });

    it("管理者以外・未所属は403、施設なしは404", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A); // facility_staff
      await seedMembership(deps, STAFF_B, FACILITY_B, "facility_admin");
      await seedFacility(deps, FACILITY_A);

      for (const uid of [STAFF_A, STAFF_B, "outsider"]) {
        const res = await app.inject({
          method: "GET",
          url: `/v1/hospitals/${FACILITY_A}/settings`,
          headers: authHeader(uid),
        });
        expect(res.statusCode).toBe(403);
      }
      const missing = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_B}/settings`,
        headers: authHeader(STAFF_B),
      });
      expect(missing.statusCode).toBe(404);
    });

    it("管理者が理由付きで受付を停止できる（監査あり）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A);

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: false, reason: "年末年始休診" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().receivingEnabled).toBe(false);

      const fac = (await deps.db.doc(`facilities/${FACILITY_A}`).get()).data()!;
      expect(fac.receivingEnabled).toBe(false);
      expect(fac.receivingDisabledBy).toBe("staff");
      expect(fac.receivingDisabledReason).toBe("年末年始休診");

      const audits = await deps.db.collection("auditEvents").get();
      const actions = audits.docs.map((d) => d.data().action);
      expect(actions).toContain("FACILITY_RECEIVING_DISABLED");
    });

    it("理由なしの停止は400", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A);

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: false },
      });
      expect(res.statusCode).toBe(400);
      expect((await deps.db.doc(`facilities/${FACILITY_A}`).get()).data()!.receivingEnabled).toBe(true);
    });

    it("施設側の停止は再開できる（監査あり・停止情報をクリア）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A, {
        receivingEnabled: false,
        receivingDisabledBy: "staff",
        receivingDisabledReason: "年末年始休診",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: true },
      });
      expect(res.statusCode).toBe(200);
      const fac = (await deps.db.doc(`facilities/${FACILITY_A}`).get()).data()!;
      expect(fac.receivingEnabled).toBe(true);
      expect(fac.receivingDisabledBy).toBeNull();
      expect(fac.receivingDisabledReason).toBeNull();
      expect(fac.receivingDisabledAt).toBeNull();

      const audits = await deps.db.collection("auditEvents").get();
      const actions = audits.docs.map((d) => d.data().action);
      expect(actions).toContain("FACILITY_RECEIVING_ENABLED");
    });

    it("運営による停止は施設側で再開できない（409）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A, {
        receivingEnabled: false,
        receivingDisabledBy: "platform",
        receivingDisabledReason: "運営緊急停止",
      });
      // 既存データ（receivingDisabledBy 未設定）も運営停止とみなす
      await seedFacility(deps, FACILITY_B, {
        receivingEnabled: false,
        receivingDisabledReason: "旧データ",
      });
      await seedMembership(deps, STAFF_A, FACILITY_B, "facility_admin");

      for (const fac of [FACILITY_A, FACILITY_B]) {
        const res = await app.inject({
          method: "PATCH",
          url: `/v1/hospitals/${fac}/settings`,
          headers: authHeader(STAFF_A),
          payload: { receivingEnabled: true },
        });
        expect(res.statusCode).toBe(409);
      }
    });

    it("PATCHは管理者以外403・施設なし404・空白のみの理由は400", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A); // facility_staff
      await seedMembership(deps, STAFF_B, FACILITY_B, "facility_admin");
      await seedFacility(deps, FACILITY_A);

      const staffPatch = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: false, reason: "x" },
      });
      expect(staffPatch.statusCode).toBe(403);

      const missing = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_B}/settings`,
        headers: authHeader(STAFF_B),
        payload: { receivingEnabled: false, reason: "x" },
      });
      expect(missing.statusCode).toBe(404);

      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      const blank = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: false, reason: "   " },
      });
      expect(blank.statusCode).toBe(400);
    });

    it("運営停止時の停止理由は施設へ返さない（運営記録は非公開）", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A, {
        receivingEnabled: false,
        receivingDisabledBy: "platform",
        receivingDisabledReason: "緊急: 不正申請の疑い",
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().receivingDisabledBy).toBe("platform");
      expect(res.json().receivingDisabledReason).toBeNull();
    });

    it("再認証が古い場合は403 REAUTH_REQUIRED", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A);
      deps.fakeAuth.authTimeByToken.set(`token-${STAFF_A}`, 1);

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: false, reason: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("REAUTH_REQUIRED");
    });

    it("状態遷移がないPATCHは冪等成功で監査も発行しない", async () => {
      const { deps, app } = await setup();
      await seedMembership(deps, STAFF_A, FACILITY_A, "facility_admin");
      await seedFacility(deps, FACILITY_A); // receivingEnabled: true

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/hospitals/${FACILITY_A}/settings`,
        headers: authHeader(STAFF_A),
        payload: { receivingEnabled: true },
      });
      expect(res.statusCode).toBe(200);
      const audits = await deps.db.collection("auditEvents").get();
      expect(audits.docs).toHaveLength(0);
    });
  });
});
