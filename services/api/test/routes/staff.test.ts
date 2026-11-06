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

  it("招待発行で STAFF_INVITED 監査が記録される（メールは含めない）", async () => {
    const { app, deps } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/hospitals/${facilityId}/staff-invitations`,
      headers: authHeader("admin"),
      payload: { email: "auditee@example.com", role: "facility_clinician" },
    });
    expect(res.statusCode).toBe(201);

    const audits = await deps.db.collection("auditEvents").get();
    const events = audits.docs
      .map((d) => d.data())
      .filter((e) => e["action"] === "STAFF_INVITED");
    expect(events).toHaveLength(1);
    expect(events[0]!["resourceType"]).toBe("facilityInvitation");
    expect(events[0]!["facilityId"]).toBe(facilityId);
    // 招待先メールアドレスは監査に残さない
    expect(JSON.stringify(events[0])).not.toContain("auditee@example.com");
    await app.close();
  });

  it("メンバーシップ失効で MEMBERSHIP_REVOKED、ロール変更で STAFF_MEMBERSHIP_UPDATED", async () => {
    const { app, deps } = await setup();
    const base = `/v1/hospitals/${facilityId}/memberships`;

    const roleRes = await app.inject({
      method: "PATCH",
      url: `${base}/staff`,
      headers: authHeader("admin"),
      payload: { role: "facility_clinician" },
    });
    expect(roleRes.statusCode).toBe(200);

    const revRes = await app.inject({
      method: "PATCH",
      url: `${base}/staff`,
      headers: authHeader("admin"),
      payload: { status: "revoked" },
    });
    expect(revRes.statusCode).toBe(200);

    const audits = await deps.db.collection("auditEvents").get();
    const events = audits.docs.map((d) => d.data());
    const updates = events.filter((e) => e["action"] === "STAFF_MEMBERSHIP_UPDATED");
    const revoked = events.filter((e) => e["action"] === "MEMBERSHIP_REVOKED");
    expect(updates).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect((revoked[0]!["details"] as { status?: string }).status).toBe("revoked");
    await app.close();
  });

  it("変更のない PATCH は監査を発行しない", async () => {
    const { app, deps } = await setup();
    const base = `/v1/hospitals/${facilityId}/memberships`;

    // revoked へ遷移（MEMBERSHIP_REVOKED が1件）
    await app.inject({
      method: "PATCH",
      url: `${base}/staff`,
      headers: authHeader("admin"),
      payload: { status: "revoked" },
    });
    // 同一 status の繰り返し PATCH は遷移なし
    const res = await app.inject({
      method: "PATCH",
      url: `${base}/staff`,
      headers: authHeader("admin"),
      payload: { status: "revoked" },
    });
    expect(res.statusCode).toBe(200);

    const audits = await deps.db.collection("auditEvents").get();
    const events = audits.docs
      .map((d) => d.data())
      .filter(
        (e) =>
          e["action"] === "STAFF_MEMBERSHIP_UPDATED" ||
          e["action"] === "MEMBERSHIP_REVOKED",
      );
    expect(events).toHaveLength(1);
    expect(events[0]!["action"]).toBe("MEMBERSHIP_REVOKED");
    // revokedAt は2回目で上書きされない（失効遷移時のみ打刻）
    const member = await deps.db.doc("facilityMemberships/staff").get();
    const firstRevokedAt = member.data()!["revokedAt"];
    await app.inject({
      method: "PATCH",
      url: `${base}/staff`,
      headers: authHeader("admin"),
      payload: { role: "facility_clinician" },
    });
    const after = await deps.db.doc("facilityMemberships/staff").get();
    expect(after.data()!["revokedAt"]).toEqual(firstRevokedAt);
    await app.close();
  });
});
