import { describe, expect, it } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import type { FastifyInstance } from "fastify";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import type { FacilityDoc } from "../../src/repos/facilities.js";

const UID = "u-facility-1";

describe("synthetic facility detail authorization", () => {
  it("rechecks receiving status and patient binding on every facility confirmation", async () => {
    const { deps, app } = await setup();
    await seedFacility(deps, "synthetic", {
      verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: UID,
    });
    const binding = deps.db.doc(`syntheticDemoPatients/${UID}`);
    const facility = deps.db.doc("facilities/synthetic");
    const confirm = async (receivingEnabled: boolean, syntheticRecipient: boolean) => {
      const res = await app.inject({ method: "GET", url: "/v1/facilities/synthetic", headers: authHeader(UID) });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.json()).toMatchObject({ receivingEnabled, syntheticRecipient });
    };
    // A newly registered patient must not acquire access just by selecting a demo facility.
    await confirm(true, false);
    await binding.set({ facilityId: "synthetic" });
    await confirm(true, true);
    await facility.update({ receivingEnabled: false });
    await confirm(false, false);
    await facility.update({ receivingEnabled: true });
    await confirm(true, true);
    await binding.set({ facilityId: "other" });
    await confirm(true, false);
    await app.close();
  });

  it.each([
    [{ verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: UID }, true],
    [{ verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: "other" }, false],
    [{ verificationStatus: "pending", syntheticDemo: false, syntheticPatientUid: UID }, false],
    [{ verificationStatus: "pending" }, false],
    [{ verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: UID, receivingEnabled: false }, false],
    [{ verificationStatus: "verified", syntheticDemo: true, syntheticPatientUid: UID }, false],
  ] as const)("only exposes a scoped boolean for %o", async (facility, allowed) => {
    const { deps, app } = await setup();
    await seedFacility(deps, "synthetic", facility);
    await deps.db.doc(`syntheticDemoPatients/${UID}`).set({ facilityId: "synthetic" });
    const res = await app.inject({ method: "GET", url: "/v1/facilities/synthetic", headers: authHeader(UID) });
    expect(res.statusCode).toBe(200);
    expect(res.json().syntheticRecipient).toBe(allowed);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.json()).not.toHaveProperty("syntheticPatientUid");
    expect(res.json()).not.toHaveProperty("syntheticDemo");
    await app.close();
  });

  it.each([undefined, {}, { facilityId: "other" }])("denies missing or mismatched patient binding %o", async (binding) => {
    const { deps, app } = await setup();
    await seedFacility(deps, "synthetic", { verificationStatus: "pending", syntheticDemo: true, syntheticPatientUid: UID });
    if (binding) await deps.db.doc(`syntheticDemoPatients/${UID}`).set(binding);
    const res = await app.inject({ method: "GET", url: "/v1/facilities/synthetic", headers: authHeader(UID) });
    expect(res.json().syntheticRecipient).toBe(false);
    await app.close();
  });
});

async function setup(): Promise<{ deps: TestDeps; app: FastifyInstance }> {
  const deps = makeTestDeps();
  await seedLegalDocuments(deps);
  await seedAccount(deps, UID);
  await seedCurrentConsents(deps, UID);
  const app = buildTestApp(deps);
  return { deps, app };
}

async function seedFacility(
  deps: TestDeps,
  facilityId: string,
  partial: Partial<FacilityDoc> = {},
): Promise<void> {
  const ts = FieldValue.serverTimestamp();
  await deps.db.doc(`facilities/${facilityId}`).set({
    facilityId,
    legalName: "テスト病院",
    displayName: "テスト病院",
    placeId: `place-${facilityId}`,
    address: { formatted: "東京都千代田区1-1" },
    verificationStatus: "verified",
    receivingEnabled: true,
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  } as unknown as Record<string, unknown>);
}

describe("POST /v1/facilities/search-nearby", () => {
  it("認証なしは 401", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/facilities/search-nearby",
      payload: { center: { latitude: 35.68, longitude: 139.76 } },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("active アカウントで空の Places 結果なら空配列を返す", async () => {
    const { deps, app } = await setup();
    deps.fakePlaces.results = [];

    const res = await app.inject({
      method: "POST",
      url: "/v1/facilities/search-nearby",
      headers: authHeader(UID),
      payload: {
        center: { latitude: 35.68, longitude: 139.76 },
        radiusMeters: 3000,
        limit: 5,
        includeTypes: ["hospital"],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().facilities).toHaveLength(0);
    await app.close();
  });

  it("参加施設と一致する placeId は receivingEnabled=true、verifiedFacilityId を返す", async () => {
    const { deps, app } = await setup();
    await seedFacility(deps, "fac-001", { placeId: "gplace-001", receivingEnabled: true });

    deps.fakePlaces.results = [
      {
        placeId: "gplace-001",
        displayName: "テスト病院",
        formattedAddress: "東京都千代田区1-1",
        lat: 35.6895,
        lng: 139.6917,
        primaryType: "hospital",
      },
      {
        placeId: "gplace-999",
        displayName: "未登録クリニック",
        formattedAddress: "東京都港区1-1",
        lat: 35.65,
        lng: 139.75,
        primaryType: "doctor",
      },
    ];

    const res = await app.inject({
      method: "POST",
      url: "/v1/facilities/search-nearby",
      headers: authHeader(UID),
      payload: { center: { latitude: 35.68, longitude: 139.76 } },
    });

    expect(res.statusCode).toBe(200);
    const { facilities } = res.json();
    expect(facilities).toHaveLength(2);

    const matched = facilities.find((f: { placeId: string }) => f.placeId === "gplace-001");
    expect(matched).toBeDefined();
    expect(matched.receivingEnabled).toBe(true);
    expect(matched.verifiedFacilityId).toBe("fac-001");
    expect(matched.source).toBe("places");

    const unmatched = facilities.find((f: { placeId: string }) => f.placeId === "gplace-999");
    expect(unmatched).toBeDefined();
    expect(unmatched.receivingEnabled).toBe(false);
    expect(unmatched.verifiedFacilityId).toBeNull();
    await app.close();
  });

  it("verificationStatus が verified でない施設は receivingEnabled=false", async () => {
    const { deps, app } = await setup();
    await seedFacility(deps, "fac-002", {
      placeId: "gplace-002",
      verificationStatus: "pending",
      receivingEnabled: true,
    });

    deps.fakePlaces.results = [
      {
        placeId: "gplace-002",
        displayName: "審査中病院",
        formattedAddress: "東京都新宿区1-1",
        lat: 35.69,
        lng: 139.70,
        primaryType: "hospital",
      },
    ];

    const res = await app.inject({
      method: "POST",
      url: "/v1/facilities/search-nearby",
      headers: authHeader(UID),
      payload: { center: { latitude: 35.68, longitude: 139.76 } },
    });

    expect(res.statusCode).toBe(200);
    const { facilities } = res.json();
    expect(facilities[0].receivingEnabled).toBe(false);
    expect(facilities[0].verifiedFacilityId).toBeNull();
    await app.close();
  });

  it("Places Gateway がエラーを投げると 503 を返す", async () => {
    const { deps, app } = await setup();
    deps.fakePlaces.shouldThrow = new Error("network error");

    const res = await app.inject({
      method: "POST",
      url: "/v1/facilities/search-nearby",
      headers: authHeader(UID),
      payload: { center: { latitude: 35.68, longitude: 139.76 } },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("症状ペイロードを含まない（Places callに body は center/radius/types のみ）", async () => {
    const { deps, app } = await setup();
    deps.fakePlaces.results = [];

    await app.inject({
      method: "POST",
      url: "/v1/facilities/search-nearby",
      headers: authHeader(UID),
      payload: {
        center: { latitude: 35.68, longitude: 139.76 },
        radiusMeters: 2000,
        limit: 3,
        includeTypes: ["hospital"],
      },
    });

    expect(deps.fakePlaces.calls).toHaveLength(1);
    const call = deps.fakePlaces.calls[0]!;
    // PlacesSearchParams に symptom/intake/phi フィールドが存在しないことを型で保証
    const keys = Object.keys(call);
    expect(keys).not.toContain("symptom");
    expect(keys).not.toContain("intakeId");
    expect(keys).toContain("latitude");
    expect(keys).toContain("longitude");
    expect(keys).toContain("radiusMeters");
    expect(keys).toContain("includeTypes");
    await app.close();
  });
});

describe("GET /v1/facilities/:facilityId", () => {
  it("認証なしは 401", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/facilities/fac-999",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("存在しない facilityId は 404", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/v1/facilities/non-existent",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("存在する施設は 200 で詳細を返す", async () => {
    const { deps, app } = await setup();
    await seedFacility(deps, "fac-100", { displayName: "正式テスト病院", receivingEnabled: true });

    const res = await app.inject({
      method: "GET",
      url: "/v1/facilities/fac-100",
      headers: authHeader(UID),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facilityId).toBe("fac-100");
    expect(body.displayName).toBe("正式テスト病院");
    expect(body.receivingEnabled).toBe(true);
    expect(body.verificationStatus).toBe("verified");
    await app.close();
  });

  it("receivingEnabled=false の施設も返す（閲覧は可能）", async () => {
    const { deps, app } = await setup();
    await seedFacility(deps, "fac-101", { receivingEnabled: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/facilities/fac-101",
      headers: authHeader(UID),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().receivingEnabled).toBe(false);
    await app.close();
  });
});
