import { defineConfig } from "vitest/config";

// Firebase エミュレータ結合テスト専用（Issue #25）。
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST が
// ループバックを指す環境でのみ実行する（helpers/emulator.ts が検証）。
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 複数ファイルが同一エミュレータDBを共有するため直列実行にする
    fileParallelism: false,
  },
});
