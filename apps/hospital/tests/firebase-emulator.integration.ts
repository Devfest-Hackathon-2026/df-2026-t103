import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { deleteApp } from "firebase/app";
import { deleteUser, getAuth, signInAnonymously } from "firebase/auth";
import { doc, getDoc, getFirestore, setDoc, terminate } from "firebase/firestore";
import { getMetadata, getStorage, ref } from "firebase/storage";
import { initializeDemoFirebase } from "../lib/firebase-demo";

// initializeDemoFirebase rejects non-demo projects and non-local endpoints.
const app = initializeDemoFirebase();
const auth = getAuth(app);
const firestore = getFirestore(app);
const storage = getStorage(app);

after(async () => {
  if (auth.currentUser) await deleteUser(auth.currentUser);
  await terminate(firestore);
  await deleteApp(app);
});

test("demo Auth, Firestore and Storage use emulator rules", async () => {
  const user = await signInAnonymously(auth);
  assert.ok(user.user.uid);

  const legalDoc = await getDoc(doc(firestore, "appConfigs/publicLegalVersion"));
  assert.equal(typeof legalDoc.exists(), "boolean");

  await assert.rejects(
    setDoc(doc(firestore, "integration-test/denied"), { synthetic: true }),
    (error: unknown) => (error as { code?: string }).code === "permission-denied",
  );
  await assert.rejects(
    getMetadata(ref(storage, "integration-test/denied")),
    (error: unknown) => (error as { code?: string }).code === "storage/unauthorized",
  );
});
