import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issues #20/#32).
      enabled: true,
      provider: "v8",
      // Gate on production code only — without this, well-covered helpers
      // under test/ (e.g. test/contract/DurableEngineStateContract.ts)
      // dilute the denominator and give src regressions slack (issue #51).
      include: ["src/**"],
      // The complete src tree, including barrel modules, is fully covered.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
