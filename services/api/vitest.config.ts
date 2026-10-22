import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each test file gets its own database cloned from a migrated template, so files can run in parallel.
    pool: "forks",
  },
});
