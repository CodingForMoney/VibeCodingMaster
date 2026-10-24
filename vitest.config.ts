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
    // Backend E2E journeys drive the full server with mock Claude sessions and
    // fixed dispatch delays; under a full parallel run they exceed the 5s default.
    testTimeout: 30_000
  }
});
