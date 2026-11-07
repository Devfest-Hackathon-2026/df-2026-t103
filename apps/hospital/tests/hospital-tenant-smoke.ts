import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import { initializeAuth, connectAuthEmulator, signInWithEmailAndPassword, inMemoryPersistence } from "firebase/auth";
import type { FirebaseHandles } from "../../../services/api/src/firebase";
import { hmacSha256Hex } from "../../../services/api/src/lib/hash";

/** Real ID tokens and HTTP routes; no API interception or production data. */
export async function hospitalTenantSmoke({ firebase, apiBaseUrl, facilityId, otherFacilityId, deliveryId, hmacSecret }: {
  firebase: FirebaseHandles; apiBaseUrl: string; facilityId: string;
  otherFacilityId: string; deliveryId: string; hmacSecret: string;
}) {
  assert.equal(process.env.FIREBASE_PROJECT_ID, "demo-mmr-dev");
  assert.match(apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "", /^127\.0\.0\.1:\d+$/);
  const resourceHash = hmacSha256Hex(hmacSecret, `audit-res:${deliveryId}`);
  const delivery = firebase.firestore.doc(`deliveries/${deliveryId}`);
  const before = (await delivery.get()).data();
  assert.equal(before?.status, "delivered", "Use the real patient delivery created by the parent scenario");
  const staff = [
    { id: facilityId, role: "facility_staff" },
    { id: otherFacilityId, role: "facility_admin" },
    { id: facilityId, role: "facility_admin" },
  ].map(({ id, role }, i) => {
    const uid = `${facilityId}-tenant-${i}`;
    const app = initializeApp({ projectId: "demo-mmr-dev", apiKey: "demo-key" }, uid);
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
    return { uid, facilityId: id, role, app, auth, membership: firebase.firestore.doc(`facilityMemberships/${uid}`) };
  });
  const own = staff[0]!;
  const other = staff[1]!;
  const manager = staff[2]!;
  try {
    for (const user of staff) {
      const email = `${user.uid}@example.test`;
      const password = "Synthetic-only-tenant-123!";
      await firebase.auth.createUser({ uid: user.uid, email, password, emailVerified: true });
      await user.membership.set({ userUid: user.uid, facilityId: user.facilityId, role: user.role, status: "active" });
      await signInWithEmailAndPassword(user.auth, email, password);
    }
    const request = async (user: typeof own, path: string, method = "GET", body?: unknown) => fetch(`${apiBaseUrl}/hospitals/${path}`, {
      method, headers: { Authorization: `Bearer ${await user.auth.currentUser!.getIdToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const list = await request(own, `${facilityId}/deliveries`);
    assert.equal(list.status, 200);
    const ownList = await list.json() as { deliveries: { deliveryId: string }[] };
    assert.ok(ownList.deliveries.some((item) => item.deliveryId === deliveryId));
    assert.ok(!JSON.stringify(ownList).includes("SYNTHETIC_QUESTIONNAIRE"), "Inbox must not include the questionnaire snapshot");
    const otherList = await request(other, `${otherFacilityId}/deliveries`);
    assert.equal(otherList.status, 200);
    assert.deepEqual((await otherList.json() as { deliveries: unknown[] }).deliveries, []);
    assert.equal((await request(other, `${facilityId}/deliveries`)).status, 403);
    assert.equal((await request(other, `${facilityId}/deliveries/${deliveryId}`)).status, 403);
    assert.equal((await request(other, `${facilityId}/deliveries/${deliveryId}/acknowledge`, "POST")).status, 403);
    // Even with a valid own facility path, another hospital's ID must look absent.
    const cross = await request(other, `${otherFacilityId}/deliveries/${deliveryId}`);
    const absent = await request(other, `${otherFacilityId}/deliveries/${facilityId}-missing`);
    assert.equal(cross.status, 404);
    assert.equal(absent.status, 404);
    const crossError = await cross.json() as { error: { code: string; message: string } };
    const absentError = await absent.json() as typeof crossError;
    assert.equal(crossError.error.code, absentError.error.code);
    assert.equal(crossError.error.message, absentError.error.message);
    assert.ok(!JSON.stringify(crossError).includes("SYNTHETIC_QUESTIONNAIRE"));
    assert.equal((await request(other, `${otherFacilityId}/deliveries/${deliveryId}/acknowledge`, "POST")).status, 404);
    assert.deepEqual((await delivery.get()).data(), before, "Denied calls must not change the delivery");
    const detail = await request(own, `${facilityId}/deliveries/${deliveryId}`);
    assert.equal(detail.status, 200);
    const ownDetail = await detail.json() as { deliveryId: string; status: string; questionnaireSnapshot: unknown };
    assert.equal(ownDetail.deliveryId, deliveryId);
    assert.equal(ownDetail.status, "delivered");
    assert.ok(JSON.stringify(ownDetail.questionnaireSnapshot).includes("SYNTHETIC_QUESTIONNAIRE"));
    assert.deepEqual((await delivery.get()).data(), before, "Viewing must not acknowledge a delivery");
    const ack = await request(own, `${facilityId}/deliveries/${deliveryId}/acknowledge`, "POST");
    assert.equal(ack.status, 200);
    const acknowledged = await ack.json() as { status: string; acknowledgedAt: string };
    assert.equal(acknowledged.status, "acknowledged");
    assert.ok(Number.isFinite(Date.parse(acknowledged.acknowledgedAt)));
    const repeat = await request(own, `${facilityId}/deliveries/${deliveryId}/acknowledge`, "POST");
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), acknowledged);
    const after = (await delivery.get()).data();
    assert.equal(after?.status, "acknowledged");
    assert.deepEqual(after?.questionnaireSnapshot, before?.questionnaireSnapshot);
    // Staff management goes through the real routes, not direct fixture updates.
    const inviteBody = { email: `${facilityId}-invite@example.test`, role: "facility_staff" };
    const ownMembershipPath = `${facilityId}/memberships/${own.membership.id}`;
    const managerBefore = (await manager.membership.get()).data();
    assert.equal((await request(own, `${facilityId}/staff-invitations`, "POST", inviteBody)).status, 403);
    assert.equal((await request(own, ownMembershipPath, "PATCH", { role: "facility_admin" })).status, 403);
    assert.equal((await request(other, `${facilityId}/staff-invitations`, "POST", inviteBody)).status, 403);
    assert.equal((await request(other, ownMembershipPath, "PATCH", { status: "revoked" })).status, 403);
    assert.equal((await own.membership.get()).data()?.role, "facility_staff");
    assert.equal((await own.membership.get()).data()?.status, "active");
    assert.equal((await request(manager, `${facilityId}/memberships/${other.membership.id}`, "PATCH", { status: "revoked" })).status, 404);
    assert.equal((await request(manager, `${facilityId}/memberships/${facilityId}-missing-member`, "PATCH", { status: "revoked" })).status, 404);
    assert.equal((await other.membership.get()).data()?.status, "active");
    for (const body of [{ status: "revoked" }, { role: "facility_staff" }]) {
      assert.equal((await request(manager, `${facilityId}/memberships/${manager.membership.id}`, "PATCH", body)).status, 403);
    }
    assert.deepEqual((await manager.membership.get()).data(), managerBefore);
    const invite = await request(manager, `${facilityId}/staff-invitations`, "POST", inviteBody);
    assert.equal(invite.status, 201);
    const invited = await invite.json() as { invitationId: string; status: string };
    assert.equal(invited.status, "pending");
    assert.deepEqual(Object.keys(invited).sort(), ["invitationId", "status"]);
    assert.equal((await request(manager, `${facilityId}/staff-invitations`, "POST", inviteBody)).status, 409);
    const invitations = await firebase.firestore.collection("facilityInvitations").where("facilityId", "==", facilityId).get();
    assert.equal(invitations.size, 1);
    assert.equal(invitations.docs[0]!.id, invited.invitationId);
    assert.equal(invitations.docs[0]!.data().invitedByUid, manager.uid);
    const changedRole = await request(manager, ownMembershipPath, "PATCH", { role: "facility_clinician" });
    assert.equal(changedRole.status, 200);
    assert.equal((await changedRole.json() as { role: string }).role, "facility_clinician");
    assert.equal((await own.membership.get()).data()?.role, "facility_clinician");
    const revoked = await request(manager, ownMembershipPath, "PATCH", { status: "revoked" });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as { status: string }).status, "revoked");
    const revokedMember = (await own.membership.get()).data();
    assert.ok(revokedMember?.revokedAt);
    const repeatedRevoke = await request(manager, ownMembershipPath, "PATCH", { status: "revoked" });
    assert.equal(repeatedRevoke.status, 200);
    assert.deepEqual((await own.membership.get()).data(), revokedMember);
    const memberAudit = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hmacSha256Hex(hmacSecret, `audit-res:${own.membership.id}`)).get();
    assert.equal(memberAudit.docs.filter((doc) => doc.data().action === "STAFF_MEMBERSHIP_UPDATED").length, 1);
    assert.equal(memberAudit.docs.filter((doc) => doc.data().action === "MEMBERSHIP_REVOKED").length, 1);
    const inviteAudit = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hmacSha256Hex(hmacSecret, `audit-res:${invited.invitationId}`)).get();
    assert.equal(inviteAudit.size, 1);
    assert.equal(inviteAudit.docs[0]!.data().action, "STAFF_INVITED");
    // Membership revocation must take effect for the same signed-in identity.
    for (const [path, method] of [[`${facilityId}/deliveries`, "GET"], [`${facilityId}/deliveries/${deliveryId}`, "GET"], [`${facilityId}/deliveries/${deliveryId}/acknowledge`, "POST"]] as const) {
      assert.equal((await request(own, path, method)).status, 403);
    }
    assert.deepEqual((await delivery.get()).data(), after);
    const audit = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", resourceHash).get();
    const events = audit.docs.map((doc) => doc.data()).filter((event) => event.actorType === "staff");
    assert.equal(events.filter((event) => event.action === "DELIVERY_ACKNOWLEDGED" && event.decision === "allow").length, 1, "An idempotent repeat must not duplicate the success audit");
    assert.equal(events.filter((event) => event.action === "DELIVERY_ACKNOWLEDGED" && event.decision === "deny").length, 1);
    assert.equal(events.filter((event) => event.action === "DELIVERY_VIEWED" && event.decision === "deny").length, 1);
    assert.equal(events.filter((event) => event.action === "DELIVERY_VIEWED" && event.decision === "allow").length, 1);
  } finally {
    const invitations = await firebase.firestore.collection("facilityInvitations").where("facilityId", "==", facilityId).get();
    const hashes = [resourceHash, hmacSha256Hex(hmacSecret, `audit-res:${facilityId}-missing`),
      ...staff.map((user) => hmacSha256Hex(hmacSecret, `audit-res:${user.membership.id}`)),
      ...invitations.docs.map((doc) => hmacSha256Hex(hmacSecret, `audit-res:${doc.id}`))];
    for (const hash of hashes) {
      const audit = await firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hash).get();
      await Promise.all(audit.docs.filter((doc) => doc.data().actorType === "staff").map((doc) => doc.ref.delete()));
    }
    await Promise.all(invitations.docs.map((doc) => doc.ref.delete()));
    for (const user of staff) {
      await user.membership.delete();
      await firebase.auth.deleteUser(user.uid).catch(() => {});
      await deleteApp(user.app);
    }
  }
}
