import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // NodeJj spawns the real jj binary and BrowserJj instantiates the wasm
    // module in a beforeAll; both are seconds of work before any assertion,
    // and vitest's 5 s test / 10 s hook defaults put three cases and one hook
    // over the wall on a developer macOS host (measured 2026-08-16). All 123
    // pass at this budget. Finite, so a hung subprocess still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-jj-coverage-${process.pid}`),
      include: ["src/**/*.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
