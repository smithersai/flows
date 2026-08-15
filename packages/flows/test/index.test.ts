import * as FlowPackage from "@smthrs/flow-next"
import * as Effect from "effect/Effect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/index.ts"

/**
 * The expected namespace list is derived from this barrel's declared
 * `@smthrs/*` dependencies, never hardcoded (issue #161). Not every package in
 * the monorepo belongs in the durable-engine barrel: CLI, gateway, testing,
 * and build-tool packages have their own public surfaces and some are
 * intentionally Node-only. Adding one of those packages must not silently
 * drag it into every browser consumer. Adding a dependency to the barrel,
 * however, fails this test until `src/index.ts` re-exports it.
 */
const packagesDir = resolve(import.meta.dirname, "..", "..")
const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
// Directory name → exported namespace name, the convention src/index.ts uses:
// kebab-case to PascalCase (engine-store → EngineStore, time-travel →
// TimeTravel).
//
// Three kinds of package are NOT re-exported and so are excluded here: the
// barrel itself (`flows`), the `platform-*` bundles, and the `tsflows*` build
// tooling. A platform bundle is chosen by the program that runs, not by the
// library it depends on — the same reason `effect`'s index does not re-export
// `@effect/platform-node` — and re-exporting all three would make one import
// resolve `node:child_process`, ZenFS, and Bun at once.
//
// The `tsflows*` packages are excluded for the same class of reason, decided in
// review when tsflows was absorbed into this repo (2026-08-15). They are the
// BUILD.ts build system — `tsflows` (install/package-manager actions),
// `tsflows-rules` (BUILD.ts rules), `tsflows-cli` (the `tsflows` binary) — not
// part of the durable flow engine surface this barrel exists to gather.
// Re-exporting them would also break two invariants the barrel holds today:
// `tsflows-rules` and `tsflows-cli` are `private: true` and never published, so
// the published `@smthrs/flows-next` would depend on packages no consumer can
// resolve; and `tsflows-cli` pulls `@effect/platform-node`, which would drag
// `node:child_process` into the barrel that `pnpm browser` asserts is
// browser-safe. Reach them through their own packages.
const namespaceName = (directory: string) =>
  directory
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
const isPlatformBundle = (name: string) => name.startsWith("platform-")
const isBuildTooling = (name: string) => name === "tsflows" || name.startsWith("tsflows-")
const packageNames = readdirSync(packagesDir)
  .filter((name) => isFile(join(packagesDir, name, "package.json")))
const manifest = JSON.parse(readFileSync(join(packagesDir, "flows", "package.json"), "utf8")) as {
  readonly dependencies?: Readonly<Record<string, string>>
}
const dependencyPackageNames = Object.keys(manifest.dependencies ?? {})
  .filter((name) => name.startsWith("@smthrs/"))
  .map((name) => name.slice("@smthrs/".length).replace(/-next$/, ""))
// `@smthrs/flow-next` is the one package re-exported FLAT rather than as a single
// namespace: writing a flow is the point of the library, so `Flow`,
// `Action`, `RetryPolicy`, and their siblings sit at the top level. Its
// contribution is therefore derived from the package's own exports, not from
// its directory name — a new authoring namespace there fails this test until
// the barrel re-exports it, exactly as a new package does.
const expected = [
  ...new Set([
    ...dependencyPackageNames
      .filter((name) => name !== "flow")
      .map(namespaceName),
    ...Object.keys(FlowPackage)
  ])
].sort()

describe("barrel", () => {
  it("derives a non-trivial universe from the barrel manifest", () => {
    // Guard the derivation itself: an empty or near-empty universe would make
    // every assertion below vacuously green.
    expect(expected.length).toBeGreaterThanOrEqual(10)
    expect(expected).toContain("EngineStore")
    expect(expected).toContain("TimeTravel")
    // the flat authoring re-export is part of the universe too
    expect(expected).toContain("Flow")
    expect(expected).toContain("Action")
  })

  it("excludes the platform bundles, and there are some to exclude", () => {
    // Guard the exclusion the same way: if `platform-*` ever stopped matching,
    // the filter would silently become a no-op instead of a decision.
    expect(packageNames.filter(isPlatformBundle).length).toBeGreaterThanOrEqual(3)
    expect(dependencyPackageNames.filter(isPlatformBundle)).toEqual([])
    expect(expected.filter((name) => name.startsWith("Platform"))).toEqual([])
  })

  it("excludes the tsflows build tooling, and there is some to exclude", () => {
    // Same guard as the platform bundles above: if `tsflows*` ever stopped
    // matching, the filter would silently become a no-op instead of a decision.
    expect(packageNames.filter(isBuildTooling).sort()).toEqual(["tsflows", "tsflows-cli", "tsflows-rules"])
    expect(dependencyPackageNames.filter(isBuildTooling)).toEqual([])
    expect(expected.filter((name) => name.startsWith("Tsflows"))).toEqual([])
  })

  it("re-exports every engine package as a namespace", () => {
    // `namespaces` is the barrel's one runtime value (issue #169) — the
    // executable statement that gives the coverage gate a non-empty
    // denominator. Everything else is a namespace re-export.
    expect(Object.keys(Flows).sort()).toEqual([...expected, "namespaces"].sort())
  })

  it("pins the runtime namespace list to the derived universe (issue #169)", () => {
    expect([...Flows.namespaces].sort()).toEqual(expected)
  })

  it.each(expected.map((name) => ({ name })))("$name namespace is populated", ({ name }) => {
    const namespace = (Flows as Record<string, object>)[name]
    expect(namespace).toBeDefined()
    expect(Object.keys(namespace ?? {}).length).toBeGreaterThan(0)
  })

  /**
   * `TimeTravel` is the one entry that is a service KEY rather than a
   * namespace, so `yield* Flows.TimeTravel` is the whole onboarding for time
   * travel (`docs/specs/Concepts/Time Travel Service.md`). That it typechecks
   * as a yieldable is the acceptance criterion; the durable tag key is what a
   * rename would silently break.
   */
  it("re-exports TimeTravel as a yieldable service key, not a namespace", () => {
    const program = Effect.gen(function*() {
      const timeTravel = yield* Flows.TimeTravel
      return timeTravel
    })
    expect(program).toBeDefined()
    expect(Flows.TimeTravel.key).toBe("@smthrs/time-travel-next/TimeTravel")
    expect(Flows.TimeTravel.layer).toBeDefined()
  })
})
