import * as FlowPackage from "@smthrs/flow-next"
import * as Effect from "effect/Effect"
import { readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/index.ts"

/**
 * The expected namespace list is DERIVED from the `packages/*` universe, never
 * hardcoded (issue #161): a literal list reproduced the #148 un-gated-universe
 * defect in the barrel dimension — a new `packages/scheduler` satisfied every
 * coverage conformance cell while the barrel silently omitted it and
 * `Flows.Scheduler` was undefined for every consumer. Deriving here means a
 * new package fails THIS test until `src/index.ts` re-exports it.
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
// Two kinds of package are NOT re-exported and so are excluded here: the
// barrel itself (`flows`), and the `platform-*` bundles. A platform bundle is
// chosen by the program that runs, not by the library it depends on — the same
// reason `effect`'s index does not re-export `@effect/platform-node` — and
// re-exporting all three would make one import resolve `node:child_process`,
// ZenFS, and Bun at once.
const namespaceName = (directory: string) =>
  directory
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
const isPlatformBundle = (name: string) => name.startsWith("platform-")
const packageNames = readdirSync(packagesDir)
  .filter((name) => isFile(join(packagesDir, name, "package.json")))
// `@smthrs/flow-next` is the one package re-exported FLAT rather than as a single
// namespace: writing a flow is the point of the library, so `Flow`,
// `Activity`, `RetryPolicy`, and their siblings sit at the top level. Its
// contribution is therefore derived from the package's own exports, not from
// its directory name — a new authoring namespace there fails this test until
// the barrel re-exports it, exactly as a new package does.
const expected = [
  ...new Set([
    ...packageNames
      .filter((name) => name !== "flows" && name !== "flow" && !isPlatformBundle(name))
      .map(namespaceName),
    ...Object.keys(FlowPackage)
  ])
].sort()

describe("barrel", () => {
  it("derives a non-trivial universe from packages/*", () => {
    // Guard the derivation itself: an empty or near-empty universe would make
    // every assertion below vacuously green.
    expect(expected.length).toBeGreaterThanOrEqual(10)
    expect(expected).toContain("EngineStore")
    expect(expected).toContain("TimeTravel")
    // the flat authoring re-export is part of the universe too
    expect(expected).toContain("Flow")
    expect(expected).toContain("Activity")
  })

  it("excludes the platform bundles, and there are some to exclude", () => {
    // Guard the exclusion the same way: if `platform-*` ever stopped matching,
    // the filter would silently become a no-op instead of a decision.
    expect(packageNames.filter(isPlatformBundle).length).toBeGreaterThanOrEqual(3)
    expect(expected.filter((name) => name.startsWith("Platform"))).toEqual([])
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
