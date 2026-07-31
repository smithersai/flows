import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      // These modules are byte-faithful upstream regions with no flows-owned
      // behavior. Thresholds below remain enforced for instrumented fork code.
      exclude: ["src/DurableDeferred.ts", "src/index.ts"],
      // Accurate, enforceable floors for the current suite. Ratchet upward as
      // tests land; never lower without a written justification.
      thresholds: {
        branches: 80,
        functions: 92,
        lines: 92,
        statements: 92
      }
    }
  }
})
