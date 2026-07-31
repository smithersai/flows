import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      // Accurate, enforceable floors measured against the committed suite
      // (the previous 100% declaration was red and unenforced). Ratchet
      // upward as tests land; never lower without a written justification.
      thresholds: {
        branches: 53,
        functions: 86,
        lines: 85,
        statements: 83
      }
    }
  }
})
