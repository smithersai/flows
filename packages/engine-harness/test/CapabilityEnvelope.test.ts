/**
 * The capability envelope parsed from a plan card's formatted strings.
 *
 * A live run in `HarnessExecutor.test.ts` covers the ordinary
 * action-and-resource forms. The bare `*` is what a markdown-declared flow
 * carries when its frontmatter names no capabilities at all.
 */
import { describe, expect, it } from "vitest"
import * as HarnessExecutor from "../src/HarnessExecutor.ts"

describe("patterns", () => {
  it("reads the bare * as whole authority", () => {
    // `**` and not `*`: `Capability.subsumes` recognises only `**` as
    // recursive, so a grant written with `*` covers nothing.
    expect(HarnessExecutor.patterns(["*"]).map((entry) => ({ action: entry.action, resource: entry.resource })))
      .toEqual([{ action: "*", resource: "**" }])
  })

  it("drops what it cannot name rather than widening it", () => {
    expect(
      HarnessExecutor.patterns(["single", "zz:yy:**", "fs:read:**"]).map((entry) => entry.action)
    ).toEqual(["fs:read"])
  })
})
