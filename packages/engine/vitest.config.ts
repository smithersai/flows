import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      // `src/index.ts` is a barrel with no behavior. `DurableDeferred.ts` is
      // no longer excluded: it now carries flows-owned behavior (the recorded
      // interrupt-only completion contract) and must be measured.
      exclude: ["src/index.ts"],
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
