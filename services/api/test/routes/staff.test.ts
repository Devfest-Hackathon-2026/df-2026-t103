import { describe, expect, it } from "vitest";
import { makeTestDeps } from "../helpers/deps.js";
import { authHeader, buildTestApp } from "../helpers/app.js";

const facilityId = "facility-1";

async function setup() {
  const deps = makeTestDeps();
  const app = buildTestApp(deps);
  await app.ready();
  await deps.db.doc("facilityMemberships/admin").set({
    userUid: "admin", facilityId, role: "facility_admin", status: "active", mfaEnforced: true,
  });
  await deps.db.doc("facilityMemberships/staff").set({
    userUid: "staff", facilityId, role: "facility_staff", status: "active", mfaEnforced: true,
  });
  return { app, deps };
}

describe("staff management", () => {
  it("only active facility admins can invite", async () => {
    const { app, deps } = await setup();
    const url = `/v1/hospitals/${facilityId}/staff-invitations`;
    const payload = { email: "new@example.com", role: "facility_staff" };
    expect((await app.inject({ method: "POST", url, headers: authHeader("staff"), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: authHeader("outsider"), payload })).statusCode).toBe(403);
    const result = await app.inject({ method: "POST", url, headers: authHeader("admin"), payload });
    expect(result.statusCode).toBe(201);
    const invitation = await deps.db.doc(`facilityInvitations/${result.json().invitationId}`).get();
    expect(invitation.data()?.email).toBe("new@example.com");
    expect((await app.inject({ method: "POST", url, headers: authHeader("admin"), payload })).statusCode).toBe(409);
    await app.close();
  });

  it("revoked staff lose access immediately", async () => {
    const { app } = await setup();
    const url = `/v1/hospitals/${facilityId}/memberships/staff`;
    const result = await app.inject({ method: "PATCH", url, headers: authHeader("admin"), payload: { status: "revoked" } });
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe("revoked");
    expect((await app.inject({ method: "POST", url: `/v1/hospitals/${facilityId}/staff-invitations`, headers: authHeader("staff"), payload: { email: "x@example.com", role: "facility_staff" } })).statusCode).toBe(403);
    await app.close();
  });
});
