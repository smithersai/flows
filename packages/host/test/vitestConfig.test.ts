import { tmpdir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import config from "../vitest.config.js"

/**
 * The coverage thresholds in `vitest.config.ts` are this package's primary
 * regression gate, so the gate itself has to be deterministic. Two concurrent
 * `vitest run` invocations in this package share `coverage/.tmp` unless the
 * report directory is derived per process: one run clears the scratch dir the
 * other is still collecting into, so one aborts with a removed-coverage-
 * directory error and the other enforces 100% against a partial profile
 * (issue #115). These cases pin the per-process derivation.
 */
describe("vitest.config coverage isolation", () => {
  const coverage = config.test?.coverage as
    | { readonly enabled?: boolean; readonly reportsDirectory?: string }
    | undefined

  it("keeps coverage enforced on every run", () => {
    expect(coverage?.enabled).toBe(true)
  })

  it("writes coverage scratch state to a process-scoped directory", () => {
    const dir = coverage?.reportsDirectory
    expect(typeof dir).toBe("string")
    expect(isAbsolute(dir!)).toBe(true)
    expect(dir).toContain(String(process.pid))
  })

  it("keeps the report directory out of the package working tree", () => {
    const dir = resolve(coverage!.reportsDirectory!)
    expect(dir.startsWith(resolve(tmpdir()))).toBe(true)
    expect(dir.startsWith(resolve(import.meta.dirname, ".."))).toBe(false)
  })
})
