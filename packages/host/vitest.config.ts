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
      // under test/ dilute the denominator and give src regressions slack
      // (issue #51).
      include: ["src/**"],
      // Accurate, enforceable floors measured against the committed suite.
      // Ratchet upward as tests land; never lower without a written
      // justification.
      // Measured src-only on the committed suite: 95.13 stmts / 91.98
      // branches / 94.28 funcs / 95.44 lines (issue #51).
      thresholds: {
        branches: 91,
        functions: 94,
        lines: 95,
        statements: 95
      }
    }
  }
})
