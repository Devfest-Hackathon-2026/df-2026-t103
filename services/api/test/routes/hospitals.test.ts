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
});
