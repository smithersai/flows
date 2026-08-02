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
// TimeTravel). The barrel itself (`flows`) is the one package not re-exported.
const namespaceName = (directory: string) =>
  directory
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
const expected = readdirSync(packagesDir)
  .filter((name) => name !== "flows" && isFile(join(packagesDir, name, "package.json")))
  .map(namespaceName)
  .sort()

describe("barrel", () => {
  it("derives a non-trivial universe from packages/*", () => {
    // Guard the derivation itself: an empty or near-empty universe would make
    // every assertion below vacuously green.
    expect(expected.length).toBeGreaterThanOrEqual(10)
    expect(expected).toContain("EngineStore")
    expect(expected).toContain("TimeTravel")
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
})
