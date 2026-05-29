import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/shared/**/*.test.ts",
      "tests/unit/backend/**/*.test.ts",
      "tests/unit/frontend/**/*.test.ts",
      "tests/integration/api/**/*.test.ts",
      "tests/integration/runtime/**/*.test.ts"
    ]
  }
});
