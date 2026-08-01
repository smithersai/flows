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
      // Accurate, enforceable floors measured against the committed suite.
      // Ratchet upward as tests land; never lower without a written
      // justification.
      // Measured src-only against the round-3 suite: 98.57 stmts / 96.51
      // branches / 99.54 funcs / 98.48 lines (issue #51).
      thresholds: {
        branches: 96,
        functions: 99,
        lines: 98,
        statements: 98
      }
    }
  }
})
