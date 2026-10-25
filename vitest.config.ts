import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/shared/**/*.test.ts",
      "tests/unit/backend/**/*.test.ts",
      "tests/unit/frontend/**/*.test.ts",
      "tests/integration/api/**/*.test.ts",
      "tests/integration/runtime/**/*.test.ts",
      "tests/e2e/backend/**/*.test.ts"
    ],
    // Many unit suites spawn git and node subprocesses, which exceed the 5s
    // default on a loaded machine. Backend E2E raises its own limit further.
    testTimeout: 15_000
  }
});
