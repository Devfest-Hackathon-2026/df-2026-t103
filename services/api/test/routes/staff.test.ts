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

  it("職員一覧は施設メンバーと保留中招待を返す（facility_admin 専用）", async () => {
    const { app, deps } = await setup();
    await deps.db.doc("facilityMemberships/clinician").set({
      userUid: "clinician", facilityId, role: "facility_clinician", status: "revoked", mfaEnforced: true,
    });
    // 他施設のメンバー・確定済み招待は含まれないこと
    await deps.db.doc("facilityMemberships/other").set({
      userUid: "other", facilityId: "facility-2", role: "facility_staff", status: "active",
    });
    await deps.db.doc("facilityInvitations/inv-pending").set({
      facilityId, email: "pending@example.com", role: "facility_staff", status: "pending",
    });
    await deps.db.doc("facilityInvitations/inv-accepted").set({
      facilityId, email: "accepted@example.com", role: "facility_staff", status: "accepted",
    });
    await deps.db.doc("facilityInvitations/inv-other-facility").set({
      facilityId: "facility-2", email: "other@example.com", role: "facility_staff", status: "pending",
    });
    deps.fakeAuthAdmin.users.set("admin", { email: "admin@example.com", password: "", emailVerified: true, disabled: false });
    deps.fakeAuthAdmin.users.set("staff", { email: "staff@example.com", password: "", emailVerified: true, disabled: false });
    // clinician は Auth 未登録 → email: null で返ること

    const url = `/v1/hospitals/${facilityId}/staff`;
    expect((await app.inject({ method: "GET", url, headers: authHeader("staff") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: authHeader("outsider") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);

    const res = await app.inject({ method: "GET", url, headers: authHeader("admin") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(3);
    const byUid = Object.fromEntries(body.members.map((m: { userUid: string }) => [m.userUid, m]));
    expect(byUid["admin"].email).toBe("admin@example.com");
    expect(byUid["staff"].email).toBe("staff@example.com");
    expect(byUid["clinician"].email).toBeNull();
    expect(byUid["clinician"].status).toBe("revoked");
    expect(byUid["other"]).toBeUndefined();

    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].email).toBe("pending@example.com");
    await app.close();
  });

  it("職員以外のロールや異常な状態のメンバーシップは一覧から除外し500にしない", async () => {
    const { app, deps } = await setup();
    await deps.db.doc("facilityMemberships/platform").set({
      userUid: "plat", facilityId, role: "platform_security_admin", status: "active",
    });
    await deps.db.doc("facilityMemberships/odd").set({
      userUid: "odd", facilityId, role: "facility_staff", status: "suspended",
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/hospitals/${facilityId}/staff`,
      headers: authHeader("admin"),
    });
    expect(res.statusCode).toBe(200);
    const uids = res.json().members.map((m: { userUid: string }) => m.userUid);
    expect(uids).not.toContain("plat");
    expect(uids).not.toContain("odd");
    expect(uids).toEqual(expect.arrayContaining(["admin", "staff"]));
    await app.close();
  });

  it("管理者は自身の停止・降格を行えない（最終管理者の喪失防止）", async () => {
    const { app } = await setup();
    const url = `/v1/hospitals/${facilityId}/memberships/admin`;
    const self = await app.inject({
      method: "PATCH", url, headers: authHeader("admin"), payload: { status: "revoked" },
    });
    expect(self.statusCode).toBe(403);
    const demote = await app.inject({
      method: "PATCH", url, headers: authHeader("admin"), payload: { role: "facility_staff" },
    });
    expect(demote.statusCode).toBe(403);
    // 他施設のメンバーシップIDを指定しても対象施設のメンバーとして解決されない
    const cross = await app.inject({
      method: "PATCH",
      url: `/v1/hospitals/${facilityId}/memberships/other`,
      headers: authHeader("admin"),
      payload: { status: "revoked" },
    });
    expect(cross.statusCode).toBe(404);
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
