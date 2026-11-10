import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import { initializeAuth, connectAuthEmulator, signInWithEmailAndPassword, inMemoryPersistence } from "firebase/auth";
import type { FirebaseHandles } from "../../../services/api/src/firebase";
import { hmacSha256Hex } from "../../../services/api/src/lib/hash";

/** Synthetic target for actual staff UI operations; no responses are stubbed. */
export async function createStaffManagementFixture({ firebase, apiBaseUrl, facilityId, hmacSecret }: {
  firebase: FirebaseHandles; apiBaseUrl: string; facilityId: string; hmacSecret: string;
}) {
  assert.equal(process.env.FIREBASE_PROJECT_ID, "demo-mmr-dev");
  assert.match(apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
  assert.match(authHost, /^127\.0\.0\.1:\d+$/);
  const uid = `${facilityId}-browser-managed`;
  const email = `${uid}@example.test`;
  const inviteEmail = `${facilityId}-browser-invite@example.test`;
  const password = "Synthetic-only-managed-123!";
  const membership = firebase.firestore.doc(`facilityMemberships/${uid}`);
  const app = initializeApp({ projectId: "demo-mmr-dev", apiKey: "demo-key" }, uid);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const invitations = () => firebase.firestore.collection("facilityInvitations").where("facilityId", "==", facilityId).where("email", "==", inviteEmail).get();
  const audits = (id: string) => firebase.firestore.collection("auditEvents").where("resourceIdHash", "==", hmacSha256Hex(hmacSecret, `audit-res:${id}`)).get();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    const invites = await invitations();
    for (const id of [membership.id, ...invites.docs.map((doc) => doc.id)]) {
      await Promise.all((await audits(id)).docs.map((doc) => doc.ref.delete()));
    }
    await Promise.all(invites.docs.map((doc) => doc.ref.delete()));
    await membership.delete();
    await firebase.auth.deleteUser(uid).catch(() => {});
    await deleteApp(app);
    cleaned = true;
  };
  try {
    await firebase.auth.createUser({ uid, email, password, emailVerified: true });
    await membership.set({ userUid: uid, facilityId, role: "facility_staff", status: "active" });
    await signInWithEmailAndPassword(auth, email, password);
    const idToken = await auth.currentUser!.getIdToken();
    return {
      email, inviteEmail, cleanup,
      assertMembership: async (role: string, status: string, updates: number, revokes: number) => {
        const data = (await membership.get()).data();
        assert.equal(data?.role, role);
        assert.equal(data?.status, status);
        assert.equal(!!data?.revokedAt, status === "revoked");
        const response = await fetch(`${apiBaseUrl}/hospitals/${facilityId}/deliveries`, { headers: { authorization: `Bearer ${idToken}` } });
        assert.equal(response.status, status === "revoked" ? 403 : 200, "Same real token must immediately follow the UI membership changes");
        const events = (await audits(membership.id)).docs.map((doc) => doc.data());
        assert.equal(events.filter((event) => event.action === "STAFF_MEMBERSHIP_UPDATED").length, updates);
        assert.equal(events.filter((event) => event.action === "MEMBERSHIP_REVOKED").length, revokes);
      },
      assertInvitations: async (count: number) => {
        const invites = await invitations();
        assert.equal(invites.size, count);
        for (const invite of invites.docs) {
          assert.equal(invite.data().status, "pending");
          assert.equal(invite.data().role, "facility_staff");
          assert.equal((await audits(invite.id)).docs.filter((doc) => doc.data().action === "STAFF_INVITED").length, 1);
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
