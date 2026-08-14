/**
 * The boundary declaration's own invariant: a path cannot be both promised and
 * disclaimed.
 *
 * `removes` exists because an absent declared write is a DEFECT — recording it
 * as valid evidence caches the claim "this file should not exist", which a
 * later replay acts on by deleting the path. Declaring the removal is what
 * makes the absence legitimate, and that only means anything while the two
 * sets stay disjoint.
 */
import { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

const decode = Schema.decodeUnknownResult(FileBoundary)

describe("FileBoundary", () => {
  it("decodes a boundary that declares no removals, and defaults it to absent", () => {
    const decoded = decode({ readSet: [], writeSet: ["out.js"], boundaryMode: "hard" })
    expect(decoded._tag).toBe("Success")
    // Optional with no default value materialized: rows persisted before
    // `removes` existed decode unchanged, which is the whole point of it being
    // optional rather than required-with-`[]`.
    expect((decoded as { success: FileBoundary }).success.removes).toBeUndefined()
  })

  it("decodes disjoint writes and removals", () => {
    const decoded = decode({
      readSet: [{ path: "src/a.ts", digest: "a" }],
      writeSet: ["out.js"],
      removes: ["stale.js"],
      boundaryMode: "expected"
    })
    expect(decoded._tag).toBe("Success")
  })

  it("decodes read globs and tree outputs while rejecting upward traversal", () => {
    expect(
      decode({
        readSet: [{ _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/generated.ts"] }],
        writeSet: [{ _tag: "TreeArtifact", path: "dist" }],
        boundaryMode: "hard"
      })._tag
    ).toBe("Success")
    expect(
      decode({
        readSet: [{ _tag: "Glob", include: ["../secret"] }],
        writeSet: [],
        boundaryMode: "hard"
      })._tag
    ).toBe("Failure")
  })

  it("refuses a path that is both written and removed", () => {
    const decoded = decode({
      readSet: [],
      writeSet: ["out.js", "both.js"],
      removes: ["both.js"],
      boundaryMode: "hard"
    })
    expect(decoded._tag).toBe("Failure")
  })

  it("refuses removals covered by a write glob or tree artifact", () => {
    expect(
      decode({
        readSet: [],
        writeSet: [{ _tag: "Glob", include: ["dist/**"] }],
        removes: ["dist/a.js"],
        boundaryMode: "hard"
      })._tag
    ).toBe("Failure")
    expect(
      decode({
        readSet: [],
        writeSet: [{ _tag: "TreeArtifact", path: "dist" }],
        removes: ["dist/a.js"],
        boundaryMode: "hard"
      })._tag
    ).toBe("Failure")
  })
})
