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
