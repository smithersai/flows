import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      // Accurate, enforceable floors measured against the committed suite,
      // re-ratcheted after the client-cursor/server-paging/transport-fault
      // suites landed (issue #33). Ratchet upward as tests land; never lower
      // without a written justification.
      thresholds: {
        branches: 85,
        functions: 96,
        lines: 97,
        statements: 96
      }
    }
  }
})
