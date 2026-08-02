import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // `enabled: true` makes every `vitest` run compute and ENFORCE these
      // thresholds — a red gate fails the run (issues #20/#32).
      enabled: true,
      provider: "v8",
      // Scope the report directory — and the `.tmp` scratch dir the v8
      // provider clears at run start and reads at run end — to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-kernel-coverage-${process.pid}`),
      include: ["src/**/*.ts"],
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
