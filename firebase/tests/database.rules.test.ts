import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { makeRulesTestEnv } from "./helpers/env.js";

/**
 * database.rules.json の許可/拒否網羅テスト（docs/04 §6/§7.2, Issue #24）。
 * 方針: /publicOperationalStatus の公開読取のみ許可。それ以外は全拒否。
 * PHI・個別識別子を置かない設計（04 §6.1）を、代表パスの拒否で確認する。
 * deny は無条件のため実データのシードは行わない。
 */

// 04 §6.1「RTDBに置いてはいけない例」の代表パス（個別患者・施設の識別が発生し得るもの）
const FORBIDDEN_PATHS = [
  "presence/patient1",
  "intake/intake1/latestSymptom",
  "ocrJobs/job1/medicationNames",
  "delivery/delivery1/facilityId",
  "typing/user1",
] as const;

describe("database.rules.json", () => {
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

      it("/publicOperationalStatus は読取可能", async () => {
        await assertSucceeds(
          ctx().database().ref("publicOperationalStatus").get(),
        );
      });

      it("/publicOperationalStatus の子ノードも読取可能", async () => {
        await assertSucceeds(
          ctx().database().ref("publicOperationalStatus/api").get(),
        );
      });

      it("/publicOperationalStatus への書込は拒否（set/update/remove）", async () => {
        const ref = ctx().database().ref("publicOperationalStatus/api");
        await assertFails(ref.set({ state: "down" }));
        await assertFails(
          ctx().database().ref("publicOperationalStatus").update({ api: { state: "down" } }),
        );
        await assertFails(ref.remove());
      });

      it("サーバ内部の operationalCounters は読取も拒否", async () => {
        await assertFails(ctx().database().ref("operationalCounters").get());
      });

      it("ルート / の読取・書込は拒否（部分公開でも全件アクセスは不可）", async () => {
        const root = ctx().database().ref("/");
        await assertFails(root.get());
        await assertFails(root.set({ a: 1 }));
        // push() は ThenableReference を返すため Promise 化してから assertFails へ渡す
        await assertFails(Promise.resolve(root.push({ a: 1 })));
      });

      it.each(FORBIDDEN_PATHS)(
        "個別識別パス %s の読取は拒否（04 §6.1）",
        async (path) => {
          await assertFails(ctx().database().ref(path).get());
        },
      );

      it.each(FORBIDDEN_PATHS)(
        "個別識別パス %s への書込は拒否（04 §6.1）",
        async (path) => {
          await assertFails(ctx().database().ref(path).set({ any: "value" }));
        },
      );

      it("任意・未知パスの読み書きは拒否", async () => {
        await assertFails(ctx().database().ref("unknownPath/x1").get());
        await assertFails(
          ctx().database().ref("unknownPath/x1").set({ a: 1 }),
        );
      });
    },
  );
});
