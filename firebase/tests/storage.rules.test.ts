import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { makeRulesTestEnv, PROJECT_ID } from "./helpers/env.js";

/**
 * storage.rules の全拒否テスト（docs/04 §7.3, Issue #24）。
 * 方針: クライアント SDK からの直接読み書きを一切許可しない。
 * アップロード/取得はサーバ発行の短命URL（GCS署名URL/認可プロキシ）経由であり
 * Firebase Storage ルールの許可を前提としない。
 */

// アプリが実際に使う想定のオブジェクトパス代表（docs/04 §5.7 アップロード系 + 任意パス）
const OBJECT_PATHS = [
  "uploads/patient1/upload1/prescription.jpg",
  "uploads/patient1/upload1/page-2.pdf",
  "arbitrary/object.bin",
] as const;

describe("storage.rules", () => {
  let testEnv: RulesTestEnvironment;
  const bucket = `gs://${PROJECT_ID}`;

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

      it.each(OBJECT_PATHS)(
        "%s のメタデータ/URL取得は拒否",
        async (path) => {
          const ref = ctx().storage(bucket).ref(path);
          await assertFails(ref.getMetadata());
          await assertFails(ref.getDownloadURL());
        },
      );

      it.each(OBJECT_PATHS)("%s への put は拒否", async (path) => {
        const ref = ctx().storage(bucket).ref(path);
        // UploadTask は Thenable だが Promise 型ではないため then() で包む
        await assertFails(
          new Promise((resolve, reject) =>
            ref.put(new Uint8Array([1, 2, 3])).then(resolve, reject),
          ),
        );
      });

      it.each(OBJECT_PATHS)("%s の delete は拒否", async (path) => {
        await assertFails(ctx().storage(bucket).ref(path).delete());
      });

      it.each(OBJECT_PATHS)(
        "%s のメタデータ更新・putString は拒否",
        async (path) => {
          const ref = ctx().storage(bucket).ref(path);
          await assertFails(ref.updateMetadata({ contentType: "text/plain" }));
          await assertFails(
            new Promise((resolve, reject) =>
              ref.putString("data").then(resolve, reject),
            ),
          );
        },
      );

      it("list / listAll は拒否（プレフィックス・ルートとも）", async () => {
        const uploads = ctx().storage(bucket).ref("uploads");
        await assertFails(uploads.listAll());
        await assertFails(uploads.list({ maxResults: 10 }));
        await assertFails(ctx().storage(bucket).ref().listAll());
      });
    },
  );
});
