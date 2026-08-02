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
  // The universe is every directory under packages/ that ships a
  // package.json — NOT the directories that already have a vitest config
  // (issue #148): deriving the universe from found configs made a new
  // config-less package invisible to every assertion below, shipping with
  // zero coverage/isolation enforcement while this suite stayed green.
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  const packages = readdirSync(packagesDir).filter((name) => isFile(join(packagesDir, name, "package.json")))
  const configs = packages.map((name) => {
    const path = join(packagesDir, name, "vitest.config.ts")
    return {
      name,
      path,
      source: isFile(path) ? readFileSync(path, "utf8") : ""
    }
  })

  it("finds every package's vitest config", () => {
    const names = configs.map((config) => config.name)
    expect(names).toContain("flows")
    expect(names).toContain("host")
    expect(names.length).toBeGreaterThanOrEqual(11)
  })

  it.each(configs)("$name ships a vitest config at all (issue #148)", ({ path, source }) => {
    // An empty source means the package exists but has no config file —
    // the exact omission the config-derived universe could never see.
    expect(source, `${path} is missing`).not.toBe("")
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

  it.each(configs)(
    "$name enforces 100% coverage over src/** on every run (issue #137)",
    ({ source }) => {
      // The thresholds are the primary regression gate, so the gate itself
      // is pinned cross-package: a sibling that drops `enabled: true`,
      // lowers a threshold, or narrows `include` must fail HERE, not go
      // silently un-enforced with its own suite green.
      expect(source).toMatch(/coverage:\s*\{[^]*?enabled:\s*true/)
      // Both shipped shapes cover every production module: `src/**` and the
      // equivalent `src/**/*.ts`.
      expect(source).toMatch(/include:\s*\[\s*"src\/\*\*(?:\/\*\.ts)?"\s*\]/)
      // The thresholds object must be FLAT (issue #147): `[^{}]*` refuses a
      // nested object, because vitest's v8 provider treats a glob key
      // (`"src/risky.ts": { lines: 0 }`) as a per-file override that removes
      // matching files from the global 100% check. The earlier `[^}]*`
      // capture stopped at the nested object's first `}` yet still contained
      // all four pinned categories, so such an override slipped the gate.
      const thresholds = source.match(/thresholds:\s*\{([^{}]*)\}/)
      expect(thresholds).not.toBeNull()
      for (const category of ["branches", "functions", "lines", "statements"]) {
        expect(thresholds![1]).toMatch(new RegExp(`${category}:\\s*100(?:\\s*,|\\s*\\})?`))
      }
      // And it must contain NOTHING BUT the four pinned categories: any
      // leftover key — a glob override without a nested object, a fifth
      // category at another value — must be widened here in review, never
      // added silently.
      const leftover = thresholds![1].replace(/\b(?:branches|functions|lines|statements):\s*100\s*,?/g, "").trim()
      expect(leftover).toBe("")
      // The gate can also be weakened without touching any pinned field
      // (issue #142): `coverage.exclude` is applied ON TOP of `include`, so
      // one entry removes arbitrary src files from the 100% denominator
      // while every assertion above still passes, and
      // `thresholds.autoUpdate` rewrites the pinned 100s downward on a red
      // run. No shipped config carries either; a package that needs an
      // exclusion must widen this conformance test in review, not add it
      // silently.
      expect(source).not.toMatch(/\bexclude\s*:/)
      expect(source).not.toMatch(/\bautoUpdate\s*:/)
    }
  )
})
