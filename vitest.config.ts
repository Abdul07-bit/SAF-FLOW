import path from "node:path";
import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./tests/env";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: TEST_ENV,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
