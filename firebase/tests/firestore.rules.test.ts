import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { makeRulesTestEnv } from "./helpers/env.js";

/**
 * firestore.rules の許可/拒否網羅テスト（docs/04 §7.1, Issue #24）。
 * 方針: deny-by-default のうえで appConfigs/publicLegalVersion の公開読取のみ許可。
 * deny は無条件のため実データのシードは不要（開発用エミュレータのデータを汚染しない）。
 */

// docs/04 §5 の全トップレベルコレクション。新規追加時はここにも列挙して拒否確認を維持する。
const DENIED_COLLECTIONS = [
  "accounts",
  "patientProfiles",
  "legalConsents",
  "intakes",
  "questionnaires",
  "medications",
  "uploads",
  "ocrJobs",
  "facilities",
  "syntheticDemoPatients",
  "facilityVerificationRecords",
  "facilityMemberships",
  "facilityInvitations",
  "deliveries",
  "deletionJobs",
  "auditEvents",
  "passkeyCredentials",
  "registrationOperations",
  "pushDevices",
  "idempotencyKeys",
  "deliveryAttempts",
] as const;

// サブコレクション（{document=**} が届くことを確認する代表例）
const DENIED_SUBCOLLECTION_DOCS = [
  "intakes/intake1/questions/q1",
  "intakes/intake1/answers/a1",
  "questionnaires/qn1/revisions/1",
  "ocrJobs/job1/candidates/c1",
] as const;

describe("firestore.rules", () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await makeRulesTestEnv();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  describe.each(["unauthenticated", "authenticated"] as const)(
    "%s context",
    (kind) => {
      const ctx = () =>
        kind === "authenticated"
          ? testEnv.authenticatedContext("user1")
          : testEnv.unauthenticatedContext();

      it("appConfigs/publicLegalVersion は読取可能", async () => {
        await assertSucceeds(
          ctx().firestore().doc("appConfigs/publicLegalVersion").get(),
        );
      });

      it("appConfigs/publicLegalVersion への書込は拒否（set/update/delete）", async () => {
        const ref = ctx().firestore().doc("appConfigs/publicLegalVersion");
        await assertFails(ref.set({ version: "x" }));
        await assertFails(ref.update({ version: "x" }));
        await assertFails(ref.delete());
      });

      it("appConfigs の list は拒否（公開doc以外の一覧漏洩防止）", async () => {
        await assertFails(ctx().firestore().collection("appConfigs").get());
      });

      it("appConfigs 配下の他ドキュメントは読取・書込とも拒否", async () => {
        const ref = ctx().firestore().doc("appConfigs/internalConfig");
        await assertFails(ref.get());
        await assertFails(ref.set({ secret: "value" }));
      });

      it("appConfigs 配下のサブコレクションは拒否", async () => {
        await assertFails(
          ctx().firestore().doc("appConfigs/publicLegalVersion/nested/x").get(),
        );
      });

      it.each(DENIED_COLLECTIONS)(
        "%s コレクションの doc 読取は拒否",
        async (collection) => {
          await assertFails(ctx().firestore().doc(`${collection}/x1`).get());
        },
      );

      it.each(DENIED_COLLECTIONS)(
        "%s コレクションの list/クエリは拒否",
        async (collection) => {
          await assertFails(ctx().firestore().collection(collection).get());
        },
      );

      it.each(DENIED_COLLECTIONS)(
        "%s コレクションへの書込は拒否",
        async (collection) => {
          await assertFails(
            ctx().firestore().doc(`${collection}/x1`).set({ any: "field" }),
          );
        },
      );

      it.each(DENIED_SUBCOLLECTION_DOCS)(
        "サブコレクション %s の読取・書込は拒否",
        async (path) => {
          const ref = ctx().firestore().doc(path);
          await assertFails(ref.get());
          await assertFails(ref.set({ any: "field" }));
        },
      );

      it("任意・未知コレクションの読み書きは拒否", async () => {
        const db = ctx().firestore();
        await assertFails(db.doc("unknownCollection/x1").get());
        await assertFails(db.doc("unknownCollection/x1").set({ a: 1 }));
      });

      it("collectionGroup クエリは拒否", async () => {
        await assertFails(ctx().firestore().collectionGroup("questions").get());
      });

      it("バッチ書込も拒否", async () => {
        const db = ctx().firestore();
        const batch = db.batch();
        batch.set(db.doc("accounts/u1"), { a: 1 });
        await assertFails(batch.commit());
      });
    },
  );

  it("認証有無に関係なく許可パス以外は同じ拒否判定（存在の有無を推測不可）", async () => {
    // 未認証と認証済みで拒否が一貫していることを代表パスで確認する
    for (const path of [
      "accounts/u1",
      "deliveries/d1",
      "appConfigs/internalConfig",
    ]) {
      await assertFails(
        testEnv.unauthenticatedContext().firestore().doc(path).get(),
      );
      await assertFails(
        testEnv.authenticatedContext("user1").firestore().doc(path).get(),
      );
    }
    // 許可パスは両者で読める
    await assertSucceeds(
      testEnv.unauthenticatedContext().firestore().doc("appConfigs/publicLegalVersion").get(),
    );
    await assertSucceeds(
      testEnv.authenticatedContext("user1").firestore().doc("appConfigs/publicLegalVersion").get(),
    );
  });
});
