import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Every package's coverage thresholds are its primary regression gate, so the
 * gate itself has to be deterministic. The v8 coverage provider clears its
 * `.tmp` scratch directory at run start and reads it at run end; with the
 * default `./coverage` report directory two concurrent `vitest run`
 * invocations in the same package destroy each other — one aborts with a
 * removed-coverage-directory error and the other enforces 100% against a
 * partial profile with every test passing (issues #115/#121). #115's fix
 * landed in packages/host only; this conformance test pins the per-process,
 * tmpdir-scoped `reportsDirectory` derivation across ALL packages so a new or
 * regressed config cannot reintroduce the collision.
 *
 * The assertion is on config source text: importing each sibling package's
 * `vitest.config.ts` cross-package would drag in each package's own tsconfig
 * and resolution context, so the deterministic source-level contract is the
 * pinned shape instead — a `reportsDirectory` built from `tmpdir()` and
 * `process.pid`.
 */
describe("vitest coverage isolation conformance", () => {
  const packagesDir = resolve(import.meta.dirname, "..", "..")
  const configs = readdirSync(packagesDir)
    .filter((name) => {
      const config = join(packagesDir, name, "vitest.config.ts")
      try {
        return statSync(config).isFile()
      } catch {
        return false
      }
    })
    .map((name) => ({
      name,
      path: join(packagesDir, name, "vitest.config.ts"),
      source: readFileSync(join(packagesDir, name, "vitest.config.ts"), "utf8")
    }))

  it("finds every package's vitest config", () => {
    const names = configs.map((config) => config.name)
    expect(names).toContain("flows")
    expect(names).toContain("host")
    expect(names.length).toBeGreaterThanOrEqual(11)
  })

  it.each(configs)(
    "$name scopes its coverage report directory to tmpdir() and process.pid",
    ({ name, source }) => {
      // The report directory must be derived per process and live outside the
      // package working tree: `join(tmpdir(), \`flows-<pkg>-coverage-${pid}\`)`.
      expect(source).toMatch(
        /reportsDirectory:\s*join\(\s*tmpdir\(\),\s*`flows-[a-z-]+-coverage-\$\{process\.pid\}`\s*\)/
      )
      // The derivation only isolates if the real node:os/node:path helpers
      // are in scope.
      expect(source).toContain(`import { tmpdir } from "node:os"`)
      expect(source).toContain(`import { join } from "node:path"`)
      expect(source).toContain(`flows-${name}-coverage`)
    }
  )
})
