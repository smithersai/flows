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
      // profile with every test passing (issue #115). Same rationale as
      // `defaultScratchPath` in `test/contract/HostContract.ts`.
      reportsDirectory: join(tmpdir(), `flows-host-coverage-${process.pid}`),
      // Gate on production code only — without this, well-covered helpers
      // under test/ dilute the denominator and give src regressions slack
      // (issue #51).
      include: ["src/**"],
      // Accurate, enforceable floors measured against the committed suite.
      // Ratchet upward as tests land; never lower without a written
      // justification.
      // Measured src-only: the package is fully covered. Every branch of the
      // Host surface — including the Windows, Bun, and unsupported-capability
      // paths this runtime never takes on its own — has a behavioural case.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
