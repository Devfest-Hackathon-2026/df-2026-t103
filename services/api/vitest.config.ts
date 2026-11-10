import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // エミュレータ結合テストは vitest.emulator.config.ts で別途実行する
    exclude: [...configDefaults.exclude, "test/integration/**"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
