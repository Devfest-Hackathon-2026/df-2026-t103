import { describe, expect, it } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { authHeader, buildTestApp } from "../helpers/app.js";

const STAFF = "staff-1";
const FACILITY = "fac-1";

async function seedFacility(deps: TestDeps, id: string, overrides: Record<string, unknown> = {}) {
  await deps.db.doc(`facilities/${id}`).set({
    facilityId: id,
    legalName: "合成医療法人",
    displayName: "さくら合成クリニック",
    address: { formatted: "東京都合成区1-2-3" },
    verificationStatus: "verified",
    receivingEnabled: true,
    serviceAgreementVersion: "v1",
    createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    ...overrides,
  });
}

async function seedMembership(
  deps: TestDeps,
  uid: string,
  facilityId: string,
  role: string = "facility_staff",
  status = "active",
) {
  await deps.db.collection("facilityMemberships").doc().set({
    userUid: uid,
    facilityId,
    role,
    status,
    createdAt: FieldValue.serverTimestamp(),
    revokedAt: null,
  });
}

describe("GET /v1/me/facility-memberships", () => {
  it("自分の施設所属と施設情報を返す（患者アカウント不要）", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    await seedFacility(deps, FACILITY);
    await seedMembership(deps, STAFF, FACILITY, "facility_admin");

    const res = await app.inject({
      method: "GET",
      url: "/v1/me/facility-memberships",
      headers: authHeader(STAFF),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        facilityId: string;
        role: string;
        facility: { displayName: string; addressFormatted: string | null; verificationStatus: string; receivingEnabled: boolean } | null;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.facilityId).toBe(FACILITY);
    expect(body.items[0]!.role).toBe("facility_admin");
    expect(body.items[0]!.facility?.displayName).toBe("さくら合成クリニック");
    expect(body.items[0]!.facility?.addressFormatted).toBe("東京都合成区1-2-3");
  });

  it("revoked 所属と非施設ロールは返さない", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    await seedFacility(deps, FACILITY);
    await seedMembership(deps, STAFF, FACILITY, "facility_staff", "revoked");
    await seedMembership(deps, STAFF, "fac-2", "platform_security_admin");

    const res = await app.inject({
      method: "GET",
      url: "/v1/me/facility-memberships",
      headers: authHeader(STAFF),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("所属なしは空配列、未認証は401", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    const empty = await app.inject({
      method: "GET",
      url: "/v1/me/facility-memberships",
      headers: authHeader(STAFF),
    });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { items: unknown[] }).items).toHaveLength(0);

    const unauth = await app.inject({ method: "GET", url: "/v1/me/facility-memberships" });
    expect(unauth.statusCode).toBe(401);
  });
});
