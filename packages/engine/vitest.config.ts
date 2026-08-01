import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      // Every production module, including the public barrel, is measured.
      include: ["src/**"],
      // The suite must earn complete coverage in every category.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
