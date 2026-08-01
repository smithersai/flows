import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issues #20/#32).
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      // Accurate, enforceable floors measured against the committed suite.
      // Ratchet upward as tests land; never lower without a written
      // justification.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
