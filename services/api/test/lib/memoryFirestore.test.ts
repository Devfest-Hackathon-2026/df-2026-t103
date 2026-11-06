import { describe, expect, it } from "vitest";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { MemoryFirestore } from "../helpers/memoryFirestore.js";

describe("MemoryFirestore", () => {
  it("set/get/delete の基本動作", async () => {
    const db = new MemoryFirestore();
    await db.doc("a/b").set({ x: 1 });
    const snap = await db.doc("a/b").get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ x: 1 });
    await db.doc("a/b").delete();
    expect((await db.doc("a/b").get()).exists).toBe(false);
  });

  it("update はドットパスを更新し、存在しない doc では失敗する", async () => {
    const db = new MemoryFirestore();
    await db.doc("a/b").set({ steps: { s1: "pending", s2: "pending" } });
    await db.doc("a/b").update({ "steps.s1": "succeeded" });
    expect((await db.doc("a/b").get()).data()).toEqual({
      steps: { s1: "succeeded", s2: "pending" },
    });
    await expect(db.doc("a/none").update({ x: 1 })).rejects.toThrow();
  });

  it("create は既存 doc で失敗する", async () => {
    const db = new MemoryFirestore();
    await db.doc("a/b").create({ x: 1 });
    await expect(db.doc("a/b").create({ x: 2 })).rejects.toThrow();
  });

  it("where/orderBy/limit のクエリ", async () => {
    const db = new MemoryFirestore();
    await db.collection("jobs").doc("j1").set({ status: "scheduled", at: Timestamp.fromMillis(300) });
    await db.collection("jobs").doc("j2").set({ status: "scheduled", at: Timestamp.fromMillis(100) });
    await db.collection("jobs").doc("j3").set({ status: "running", at: Timestamp.fromMillis(50) });
    const snap = await db
      .collection("jobs")
      .where("status", "==", "scheduled")
      .where("at", "<=", Timestamp.fromMillis(200))
      .orderBy("at", "asc")
      .limit(10)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(["j2"]);
  });

  it("in / array-contains / !=", async () => {
    const db = new MemoryFirestore();
    await db.collection("c").doc("1").set({ s: "a", tags: ["x", "y"] });
    await db.collection("c").doc("2").set({ s: "b", tags: ["z"] });
    expect(
      (await db.collection("c").where("s", "in", ["a", "b"]).get()).size,
    ).toBe(2);
    expect(
      (await db.collection("c").where("tags", "array-contains", "x").get()).docs[0]!.id,
    ).toBe("1");
    expect(
      (await db.collection("c").where("s", "!=", "a").get()).docs[0]!.id,
    ).toBe("2");
  });

  it("runTransaction で tx.get/set/update/create/delete が使える", async () => {
    const db = new MemoryFirestore();
    await db.doc("a/b").set({ n: 1 });
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.doc("a/b"));
      await tx.update(db.doc("a/b"), { n: (snap.data()!.n as number) + 1 });
      await tx.create(db.doc("a/c"), { created: true });
      return snap.data()!.n;
    });
    expect(out).toBe(1);
    expect((await db.doc("a/b").get()).data()!.n).toBe(2);
    expect((await db.doc("a/c").get()).exists).toBe(true);
  });

  it("serverTimestamp が現在時刻に解決される", async () => {
    const db = new MemoryFirestore();
    db.setNow(1_700_000_000_000);
    await db.doc("a/b").set({ t: FieldValue.serverTimestamp() });
    const t = (await db.doc("a/b").get()).data()!.t as Timestamp;
    expect(t.toMillis()).toBe(1_700_000_000_000);
  });

  it("FieldValue.delete() でフィールドが消える", async () => {
    const db = new MemoryFirestore();
    await db.doc("a/b").set({ keep: 1, drop: 2 });
    await db.doc("a/b").update({ drop: FieldValue.delete() });
    expect((await db.doc("a/b").get()).data()).toEqual({ keep: 1 });
  });

  it("listCollections と collectionGroup", async () => {
    const db = new MemoryFirestore();
    await db.doc("intakes/i1/visits/v1").set({ patientUid: "u1" });
    await db.doc("intakes/i2/visits/v2").set({ patientUid: "u2" });
    const subs = await db.doc("intakes/i1").listCollections();
    expect(subs.map((s) => s.id)).toContain("visits");
    const snap = await db
      .collectionGroup("visits")
      .where("patientUid", "==", "u1")
      .get();
    expect(snap.docs.map((d) => d.ref.path)).toEqual(["intakes/i1/visits/v1"]);
  });
});
