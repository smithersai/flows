import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Every package's coverage thresholds are its primary regression gate, so the
 * gate itself has to be deterministic. The v8 coverage provider clears its
 * `.tmp` scratch directory at run start and reads it at run end; with the
 * default `./coverage` report directory two concurrent `vitest run`
 * invocations in the same package destroy each other — one aborts with a
 * removed-coverage-directory error and the other enforces 100% against a
 * partial profile with every test passing (issues #115/#121). #115's fix
 * landed in one package only; this conformance test pins the per-process,
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
    expect(names).toContain("kernel")
    expect(names.length).toBeGreaterThanOrEqual(11)
  })

  it.each(configs)("$name ships a vitest config at all (issue #148)", ({ path, source }) => {
    // An empty source means the package exists but has no config file —
    // the exact omission the config-derived universe could never see.
    expect(source, `${path} is missing`).not.toBe("")
  })

  it.each(packages.map((name) => ({ name })))(
    "$name retains Effect-style source exports and declares built publication exports",
    ({ name }) => {
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly exports?: Record<string, string>
        readonly publishConfig?: {
          readonly exports?: Record<string, string | Record<string, string>>
        }
      }
      expect(manifest.exports?.["."]).toBe("./src/index.ts")
      expect(manifest.exports?.["./*"]).toBe("./src/*.ts")
      for (const subpath of [".", "./*"] as const) {
        const target = manifest.publishConfig?.exports?.[subpath]
        expect(target).toEqual({
          types: subpath === "." ? "./dist/esm/index.d.ts" : "./dist/esm/*.d.ts",
          import: subpath === "." ? "./dist/esm/index.js" : "./dist/esm/*.js",
          require: subpath === "." ? "./dist/cjs/index.js" : "./dist/cjs/*.js"
        })
      }
    }
  )

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
      // The capture group always exists when the match does; `?? ""` only
      // satisfies `noUncheckedIndexedAccess`, and an empty body would fail
      // every category assertion below anyway.
      const pinned = thresholds?.[1] ?? ""
      for (const category of ["branches", "functions", "lines", "statements"]) {
        expect(pinned).toMatch(new RegExp(`${category}:\\s*100(?:\\s*,|\\s*\\})?`))
      }
      // And it must contain NOTHING BUT the four pinned categories: any
      // leftover key — a glob override without a nested object, a fifth
      // category at another value — must be widened here in review, never
      // added silently.
      const leftover = pinned.replace(/\b(?:branches|functions|lines|statements):\s*100\s*,?/g, "").trim()
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
      // `coverage.all: false` and a narrowed `coverage.extension` list are
      // the same silent-denominator-shrinking mechanism (issue #152): the
      // v8 provider defaults `all: true`, so every src file no test loads
      // still counts against the 100% thresholds; `all: false` (or an
      // extension list that drops files) restricts the check to files tests
      // happen to load while every pinned assertion above stays green.
      expect(source).not.toMatch(/\ball\s*:/)
      expect(source).not.toMatch(/\bextension\s*:/)
      // The provider itself must be pinned to "v8" (issue #157): the whole
      // ignore-directive inventory below is written against the v8 provider's
      // hint grammar, and a silent flip to `provider: "istanbul"` would
      // activate `istanbul ignore` comments under a different parser while
      // every assertion above stays green.
      expect(source).toMatch(/provider:\s*"v8"/)
      // `coverage.ignoreClassMethods` subtracts every method with a matching
      // name from the denominator with no per-site comment to inventory —
      // forbid it outright (issue #157).
      expect(source).not.toMatch(/\bignoreClassMethods\s*:/)
    }
  )

  it.each(packages.map((name) => ({ name })))(
    "$name pins the test script CI actually invokes (issue #158)",
    ({ name }) => {
      // CI runs the root `npm test`, which is `npm run test --workspaces
      // --if-present`: a package that deletes or stubs its `scripts.test` is
      // silently never run while every config-level assertion above stays
      // green. The script CI invokes is therefore pinned here to the exact
      // canonical value every package ships — plain `vitest`, whose default
      // command in non-interactive CI is a single run with the package's own
      // config (and its 100% coverage gate) applied.
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly scripts?: Record<string, string>
      }
      expect(manifest.scripts?.test, `packages/${name}/package.json scripts.test`).toBe("vitest")
    }
  )

  it("pins the root workspaces globs to the conformance universe (issue #154)", () => {
    // The universe above is derived from `packages/`; that is complete only
    // while `packages/*` is the WHOLE workspace. A second glob (`apps/*`)
    // would ship its packages with no coverage gate at all while every cell
    // here stayed green — the #148 defect reinstated silently. Adding a
    // workspace root means widening this assertion AND the universe
    // derivation above, in review.
    //
    // Widened once, deliberately: `examples` is a private, unpublished
    // workspace of runnable documentation programs. It ships no `src` tree
    // and no coverage gate, and the universe derivation above still reads
    // `packages/` only, so it adds no ungated publishable surface. It is a
    // workspace so its end-to-end suite resolves the real `@smthrs/*`
    // packages and runs under the root `npm test` fan-out.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly workspaces?: ReadonlyArray<string>
    }
    expect(root.workspaces).toEqual(["packages/*", "examples"])
  })

  it("pins the root aggregator scripts CI invokes (issue #166)", () => {
    // The per-package `scripts.test` pin (issue #158) covered the leaves but
    // not the root: CI runs `npm test`, and the root aggregator is what fans
    // that out across every workspace. Narrowing it — e.g. to
    // `--workspace packages/flows` — silently dropped siblings from CI while
    // every per-package cell and the workspaces-glob cell stayed green. The
    // exact aggregator bodies are pinned here; changing how CI fans out
    // means widening this assertion in review.
    //
    // `test:examples` is a named alias for the examples workspace only. The
    // root `test` fan-out already reaches it, so the alias is a documentation
    // entry point rather than a second enforcement path.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>
    }
    expect(root.scripts).toEqual({
      browser: "node scripts/browser-check.mjs",
      check: "npm run check --workspaces --if-present",
      circular: "npm run circular --workspaces --if-present",
      lint: "npm run lint --workspaces --if-present",
      test: "npm run test --workspaces --if-present",
      "test:examples": "npm run test --workspace @smthrs/examples"
    })
  })

  it("pins the CI steps that reach the aggregators and the jj install (issue #166)", () => {
    // The yml is the last unpinned hop: a step that stops calling `npm test`
    // (or drops the jj install the real-binary host suite requires, issue
    // #163) skips enforcement with every conformance cell green. Source-text
    // pins, matching the config-source approach used across this suite.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toMatch(/npm install --global npm@\d+\.\d+\.\d+ --ignore-scripts/)
    expect(ci).toMatch(/^\s*- run: npm ci --ignore-scripts$/m)
    expect(ci).toMatch(/^\s*run: npm run check$/m)
    expect(ci).toMatch(/^\s*run: npm run lint$/m)
    expect(ci).toMatch(/^\s*run: npm run circular$/m)
    // Browser support is a hard requirement met through layers; `npm run
    // browser` is the only thing that proves it, so CI has to call it
    // (REVIEW.md blocker 7).
    expect(ci).toMatch(/^\s*run: npm run browser$/m)
    expect(ci).toMatch(/^\s*run: npm test$/m)
    expect(ci).toMatch(/tool: jj-cli@\d+\.\d+\.\d+/)
    expect(ci).toMatch(/^\s*run: jj git init --colocate$/m)
  })

  it("smoke-validates packed artifacts before rerunnable publication", () => {
    const release = readFileSync(join(packagesDir, "..", ".github", "workflows", "release.yml"), "utf8")
    const smoke = release.indexOf("Pack and smoke-test release artifacts")
    const publish = release.indexOf("Publish packages in dependency order")
    expect(smoke).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(smoke)
    expect(release).toContain("node scripts/pack-release.mjs \"$PACK_DIR\"")
    expect(release).toContain("node scripts/smoke-release.mjs \"$PACK_DIR\"")
    // The publish CLI must be the exact npm CI validated, so the two
    // workflows' pins may only move together.
    const pinPattern = /npm install --global npm@(\d+\.\d+\.\d+) --ignore-scripts/
    const releasePin = release.match(pinPattern)
    const ciPin = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
      .match(pinPattern)
    expect(releasePin?.[1]).toBeDefined()
    expect(releasePin?.[1]).toBe(ciPin?.[1])
    expect(release).toContain("npm publish \"$PACK_DIR/$tarball\"")
    expect(release).toContain("npm view \"$spec\" version")
    // The published set and its order are read out of the pack manifest, so a
    // restated package list cannot drift from what was packed. `scripts/
    // pack-release.test.mjs` holds the rest of that conformance suite.
    expect(release).toContain("manifest.json")
    expect(release).not.toContain("publish_if_missing")
    const packScript = readFileSync(join(packagesDir, "..", "scripts", "pack-release.mjs"), "utf8")
    const smokeScript = readFileSync(join(packagesDir, "..", "scripts", "smoke-release.mjs"), "utf8")
    expect(packScript).toContain("publicationManifest(manifest)")
    expect(packScript).toContain("\"npm\",")
    expect(packScript).toContain("\"pack\"")
    expect(smokeScript).toContain("await import('@smthrs/flows')")
    expect(smokeScript).toContain("require('@smthrs/flows')")
    // Validation after publish cannot protect the release that was just
    // exposed. The smoke check and publication live in the same gated job.
    expect(release).not.toMatch(/^\s+smoke:\s*$/m)
  })

  it("pins the CI triggers and forbids step conditions on enforcement (issue #176)", () => {
    // The #166 pins cover the run commands but not the two cheapest silent
    // disables: deleting `pull_request:` from the `on:` block (CI stops
    // gating PRs while every run-line regex still matches), or adding an
    // `if:` condition to a named step (its separate `run:` line matches
    // verbatim regardless). Pin the trigger block exactly, and assert the
    // workflow contains no `if:` key at all — any conditional execution of
    // an enforcement step must widen this cell in review.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m)
    expect(ci).not.toMatch(/^\s*if:/m)
  })

  it("inventories every coverage-ignore directive against a pinned allowlist (issues #153/#157)", () => {
    // An ignore hint is subtracted from the denominator BEFORE the 100%
    // thresholds are evaluated, so a one-line comment is the cheapest way to
    // ship an uncovered branch with zero test failures. Every directive in
    // any package's src tree must appear here, with its count: adding one —
    // or moving one — means widening this allowlist in review, with the
    // justification the diff forces into the open.
    //
    // The inventory matches the provider's FULL hint grammar (issue #157):
    // the v8 provider parses hints via ast-v8-to-istanbul, whose regex is
    // /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file)(?=\W|$)/
    // plus a start/stop range variant — so `c8 ignore next`,
    // `istanbul ignore else`, and `node:coverage ignore file` are all live
    // directives that the earlier literal-`v8 ignore` grep never saw.
    const directive = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file|start|stop)(?=\W|$)/g
    const allowlist: Record<string, number> = {
      // Three unreachable-by-construction branches in the plan scheduler: the
      // ready-set can never be empty while work is pending (the compiler
      // rejects cycles), the dispatch key is built from strings so
      // canonicalization cannot reject it, and the merge node's elaboration
      // cannot hit any of `Plan.append`'s four refusals.
      "engine-store/src/PlanScheduler.ts": 3,
      "engine-store/src/internal/RunCoordinator.ts": 1,
      "engine/src/FlowEngine/make.ts": 1,
      "journal/src/SqlJournal.ts": 1,
      // Plan order closes every dependency before its dependent, so the
      // transitive-closure fallback is unreachable.
      "plan/src/Plan.ts": 1,
      // Every `flows_plans` column carries a CHECK constraint, so a row that
      // fails the row decode cannot be written.
      "plan/src/PlanStore.ts": 1,
      // The planned-value placeholder's proxy target is callable only so the
      // `apply` trap fires; the target body itself is unreachable by
      // construction because every application enters the trap.
      "plan/src/Planned.ts": 1,
      "run-store/src/AttemptStore.ts": 1,
      "run-store/src/RunStore.ts": 1,
      "step-cache/src/CacheStore.ts": 1
    }
    const sourceFiles = (directory: string): Array<string> => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return []
      }
      return entries.flatMap((entry) =>
        entry.isDirectory()
          ? sourceFiles(join(directory, entry.name))
          : entry.name.endsWith(".ts")
          ? [join(directory, entry.name)]
          : []
      )
    }
    const found: Record<string, number> = {}
    for (const name of packages) {
      for (const path of sourceFiles(join(packagesDir, name, "src"))) {
        const source = readFileSync(path, "utf8")
        const file = relative(packagesDir, path)
        let count = 0
        for (const match of source.matchAll(directive)) {
          const form = match[1]
          // The `file` form drops the ENTIRE file out of the 100%
          // denominator, and start/stop ranges hide arbitrarily large
          // regions behind a single allowlist count — all three are
          // forbidden outright, never allowlisted (issue #157).
          expect(
            form,
            `${file} uses the forbidden "ignore ${form}" form: "${match[0]}"`
          ).not.toMatch(/^(?:file|start|stop)$/)
          count += 1
        }
        if (count > 0) {
          found[file] = count
        }
      }
    }
    expect(found).toEqual(allowlist)
  })
})
