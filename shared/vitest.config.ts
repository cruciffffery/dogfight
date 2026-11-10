import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text", "json-summary"],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
