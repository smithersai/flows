import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Bazel's js_test runs from a runfiles symlink forest. Vite realpaths
  // imported modules by default, which would move their URLs outside the
  // working directory and leave the v8 coverage include globs matching files
  // that never "executed". TEST_SRCDIR is set only under `bazel test`, so the
  // pnpm-driven gate is unaffected.
  resolve: { preserveSymlinks: process.env.TEST_SRCDIR !== undefined },
  test: {
    environment: "node",
    // The property suite invokes Effect's one-shot crypto service hundreds of
    // times. Under the root workspace gate that shares CPU with every package,
    // it can legitimately take longer than Vitest's 5 s default.
    testTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-crypto-coverage-${process.pid}`),
      include: ["src/**/*.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
