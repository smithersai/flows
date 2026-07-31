import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      // These modules are byte-faithful upstream regions with no flows-owned
      // behavior. Thresholds below remain enforced for instrumented fork code.
      exclude: ["src/DurableDeferred.ts", "src/index.ts"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
