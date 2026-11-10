import { describe, expect, it, vi } from "vitest";
import { makeTestDeps } from "../helpers/deps.js";
import { authHeader, buildTestApp, seedAccount, seedCurrentConsents, seedLegalDocuments } from "../helpers/app.js";
import { deleteSelfServiceDemo, selfServiceFacilityId, startSyntheticDemo } from "../../src/services/syntheticDemo.js";
import { verifyFacility } from "../../src/services/operator.js";

const uid = "synthetic-self-patient";
const url = "/v1/me/synthetic-demo";
async function setup(enabled = true, max = 1000) {
  const deps = makeTestDeps({ syntheticSelfServiceEnabled: enabled, syntheticSelfServiceMaxFacilities: max });
  await seedLegalDocuments(deps);
  await seedAccount(deps, uid);
  await seedCurrentConsents(deps, uid);
  const app = buildTestApp(deps);
  return { deps, app, start: (payload: Record<string, unknown> = { syntheticDataOnly: true }, headers = authHeader(uid)) =>
    app.inject({ method: "POST", url, headers, payload }) };
}

describe("explicit storage-only synthetic demo", () => {
  it.each([
    { selfServiceVersion: 2 },
    { selfServiceVersion: null },
    { facilityId: selfServiceFacilityId("other-patient") },
  ])("cleanup rejects malformed self-service binding %o atomically on every retry", async (mutation) => {
    const { deps, app, start } = await setup();
    await start();
    const bindingRef = deps.db.doc(`syntheticDemoPatients/${uid}`);
    const facilityRef = deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`);
    await bindingRef.update(mutation);
    const originalBinding = (await bindingRef.get()).data();
    const originalFacility = (await facilityRef.get()).data();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(deleteSelfServiceDemo(deps, uid)).rejects.toMatchObject({ statusCode: 409 });
      expect((await bindingRef.get()).data()).toEqual(originalBinding);
      expect((await facilityRef.get()).data()).toEqual(originalFacility);
    }
    await app.close();
  });

  it("cleanup detects malformed binding left behind by an earlier partial deletion", async () => {
    const { deps, app } = await setup();
    const bindingRef = deps.db.doc(`syntheticDemoPatients/${uid}`);
    await bindingRef.set({ facilityId: selfServiceFacilityId(uid), selfServiceVersion: 2 });
    await expect(deleteSelfServiceDemo(deps, uid)).rejects.toMatchObject({ statusCode: 409 });
    expect((await bindingRef.get()).data()?.selfServiceVersion).toBe(2);
    await app.close();
  });
  it("does not silently complete cleanup of a now-verified owned sandbox", async () => {
    const { deps, app, start } = await setup();
    await start();
    await deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`).update({ verificationStatus: "verified" });
    await expect(deleteSelfServiceDemo(deps, uid)).rejects.toMatchObject({ statusCode: 409 });
    expect((await deps.db.doc(`syntheticDemoPatients/${uid}`).get()).exists).toBe(true);
    await app.close();
  });

  it.each([-1, 1.5, "1", null])("rejects malformed quota counter %s without writes", async (createdCount) => {
    const { deps, app, start } = await setup();
    await deps.db.doc("syntheticDemoProvisioning/selfService").set({ createdCount });
    expect((await start()).statusCode).toBe(412);
    expect((await deps.db.collection("facilities").get()).empty).toBe(true);
    await app.close();
  });
  it("never exposes a synthetic facility as a real Places match even if its status is changed", async () => {
    const { deps, app, start } = await setup();
    await start();
    await deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`).update({ placeId: "place-demo", verificationStatus: "verified" });
    deps.fakePlaces.results = [{ placeId: "place-demo", displayName: "Places entry", formattedAddress: "架空", lat: 35, lng: 139, primaryType: "hospital" }];
    const res = await app.inject({ method: "POST", url: "/v1/facilities/search-nearby", headers: authHeader(uid), payload: { center: { latitude: 35, longitude: 139 } } });
    expect(res.json().facilities[0]).toMatchObject({ verifiedFacilityId: null, receivingEnabled: false });
    await app.close();
  });
  it("account cleanup is idempotent, ownership scoped, and does not replenish lifetime quota", async () => {
    const { deps, app, start } = await setup();
    await start();
    expect(await deleteSelfServiceDemo(deps, "other")).toBe(0);
    expect(await deleteSelfServiceDemo(deps, uid)).toBe(2);
    expect(await deleteSelfServiceDemo(deps, uid)).toBe(0);
    expect((await deps.db.doc("syntheticDemoProvisioning/selfService").get()).data()?.createdCount).toBe(1);
    await deps.db.doc(`syntheticDemoPatients/${uid}`).set({ facilityId: "synthetic-demo-taichi-20261109" });
    await deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`).set({ facilityId: selfServiceFacilityId(uid), verificationStatus: "verified", syntheticPatientUid: "other" });
    expect(await deleteSelfServiceDemo(deps, uid)).toBe(0);
    expect((await deps.db.doc(`syntheticDemoPatients/${uid}`).get()).data()?.facilityId).toBe("synthetic-demo-taichi-20261109");
    await app.close();
  });
  it("is default off and does not create bindings during ordinary authenticated reads", async () => {
    const { deps, app, start } = await setup(false);
    await app.inject({ method: "GET", url: "/v1/me", headers: authHeader(uid) });
    expect((await start()).statusCode).toBe(404);
    expect((await deps.db.collection("facilities").get()).empty).toBe(true);
    expect((await deps.db.doc(`syntheticDemoPatients/${uid}`).get()).exists).toBe(false);
    await app.close();
  });

  it("creates one pending private facility and both bindings; replay does not change them or count", async () => {
    const { deps, app, start } = await setup();
    const res = await start();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ facilityId: selfServiceFacilityId(uid), syntheticRecipient: true,
      verificationStatus: "pending", mode: "storage_only", hospitalViewing: "unconfirmed" });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect((await start()).json()).toEqual(res.json());
    const facility = (await deps.db.doc(`facilities/${res.json().facilityId}`).get()).data();
    expect(facility).toMatchObject({ syntheticPatientUid: uid, syntheticDemo: true, syntheticSelfService: true, verificationStatus: "pending" });
    expect(facility).not.toHaveProperty("placeId");
    expect((await deps.db.doc("syntheticDemoProvisioning/selfService").get()).data()?.createdCount).toBe(1);
    expect((await deps.db.collection("facilityMemberships").get()).empty).toBe(true);
    expect((await deps.db.doc(`accounts/${uid}`).get()).data()?.accountStatus).toBe("active");
    await app.close();
  });

  it.each([{}, { syntheticDataOnly: false }, { syntheticDataOnly: true, uid: "other" },
    { syntheticDataOnly: true, facilityId: "real" }])("rejects absent opt-in and client ownership fields: %o", async (payload) => {
    const { deps, app, start } = await setup();
    expect((await start(payload)).statusCode).toBe(400);
    expect((await deps.db.collection("facilities").get()).empty).toBe(true);
    await app.close();
  });

  it("requires authentication, App Check, token email verification, profile and standing consents", async () => {
    const { deps, app, start } = await setup();
    expect((await start({ syntheticDataOnly: true }, {})).statusCode).toBe(401);
    vi.spyOn(deps.fakeAuth, "verifyIdToken").mockResolvedValueOnce({ uid, emailVerified: false, authTimeSeconds: 1, signInProvider: "password", providers: ["password"] });
    expect((await start()).statusCode).toBe(403);
    await deps.db.doc(`accounts/${uid}`).update({ accountStatus: "onboarding_pending", onboardingState: "profile_pending" });
    expect((await start()).statusCode).toBe(403);
    await seedAccount(deps, uid);
    const consents = await deps.db.collection("legalConsents").get();
    await consents.docs[0]!.ref.update({ revokedAt: new Date() });
    expect((await start()).statusCode).toBe(412);
    await app.close();
    const enforced = makeTestDeps({ syntheticSelfServiceEnabled: true, appCheckMode: "enforce" });
    const checked = buildTestApp(enforced);
    expect((await checked.inject({ method: "POST", url, headers: authHeader(uid), payload: { syntheticDataOnly: true } })).statusCode).toBe(401);
    await checked.close();
  });

  it.each(["suspended", "pending_deletion", "deleted"] as const)("denies %s accounts", async (accountStatus) => {
    const { deps, app, start } = await setup();
    await seedAccount(deps, uid, { accountStatus });
    expect((await start()).statusCode).toBe(403);
    await app.close();
  });

  it.each(["synthetic-demo-taichi-20261109", "real-verified", "other-patient-facility"])("never overwrites existing binding %s", async (facilityId) => {
    const { deps, app, start } = await setup();
    const original = { facilityId, preserved: true };
    await deps.db.doc(`syntheticDemoPatients/${uid}`).set(original);
    expect((await start()).statusCode).toBe(409);
    expect((await deps.db.doc(`syntheticDemoPatients/${uid}`).get()).data()).toEqual(original);
    expect((await deps.db.collection("facilities").get()).empty).toBe(true);
    await app.close();
  });

  it.each([
    { verificationStatus: "verified" }, { syntheticPatientUid: "other" },
    { receivingEnabled: false }, { syntheticDemo: false }, { syntheticSelfService: false },
  ])("does not repair mutated facility %o", async (mutation) => {
    const { deps, app, start } = await setup();
    expect((await start()).statusCode).toBe(200);
    const ref = deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`);
    await ref.update(mutation);
    expect((await start()).statusCode).toBe(409);
    expect((await ref.get()).data()).toMatchObject(mutation);
    await app.close();
  });

  it("fails closed on a colliding facility without binding", async () => {
    const { deps, app, start } = await setup();
    const original = { verificationStatus: "verified", preserved: true };
    await deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`).set(original);
    expect((await start()).statusCode).toBe(409);
    expect((await deps.db.doc(`facilities/${selfServiceFacilityId(uid)}`).get()).data()).toEqual(original);
    await app.close();
  });

  it("enforces lifetime cap, allows own replay at cap, and rate limits requests", async () => {
    const { deps, app, start } = await setup(true, 1);
    expect((await start()).statusCode).toBe(200);
    expect((await start()).statusCode).toBe(200);
    await seedAccount(deps, "other");
    await seedCurrentConsents(deps, "other");
    expect((await start({ syntheticDataOnly: true }, authHeader("other"))).statusCode).toBe(412);
    for (let i = 0; i < 3; i++) expect((await start()).statusCode).toBe(200);
    expect((await start()).statusCode).toBe(429);
    await app.close();
  });

  it("transaction rechecks state even when called directly, and cannot verify a synthetic facility", async () => {
    const { deps, app, start } = await setup();
    await start();
    await expect(verifyFacility(deps, { facilityId: selfServiceFacilityId(uid), operatorUid: "operator", verificationRecordId: "test",
      checks: { existence: true, applicant: true, receiverContact: true, location: true } })).rejects.toMatchObject({ statusCode: 403 });
    await deps.db.doc(`accounts/${uid}`).update({ accountStatus: "suspended" });
    await expect(startSyntheticDemo(deps, uid, true)).rejects.toMatchObject({ statusCode: 403 });
    await app.close();
  });
});
