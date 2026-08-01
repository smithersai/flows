import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issue #20).
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      // The suite covers every reachable statement, branch, function, and
      // line in the package, including its test transport boundary.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
