import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as Grep from "../src/Grep.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Grep", () => {
  it("searches regexes and literal text with 1-based line numbers", async () => {
    const files = { "/src/a.ts": "one\nfoo.bar\nthree", "/src/b.js": "fooXbar" }
    const regex = await execute(
      Effect.provide(Grep.run({ pattern: "foo.bar", root: "/src", include: "*.ts" }), layer({ files }))
    )
    const literal = await execute(
      Effect.provide(Grep.run({ pattern: "foo.bar", literal: true, root: "/src" }), layer({ files }))
    )
    expect(regex.matches).toEqual([{ file: "/src/a.ts", line: 2, text: "foo.bar" }])
    expect(literal.matches).toEqual([{ file: "/src/a.ts", line: 2, text: "foo.bar" }])
    expect(regex.filesSearched).toBe(1)
  })

  it("caps previews, skips binary files, and counts searched files", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "x", root: "/src" }),
      layer({
        files: { "/src/long.txt": "x".repeat(600), "/src/binary.bin": "before\0after" }
      })
    ))
    expect(result.matches[0]?.text.length).toBeLessThanOrEqual(500)
    expect(result).toMatchObject({ filesSearched: 2, skippedBinary: 1 })
  })

  it("reports invalid regular expressions as typed failures", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Grep.run({ pattern: "[", root: "/src" })),
      layer({
        files: { "/src/a.txt": "text" }
      })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("invalid_pattern")
    }
  })

  it("collects evidence past the limit and discloses truncation", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "hit", root: "/src", limit: 1 }),
      layer({
        files: { "/src/a.txt": "hit\nhit" }
      })
    ))
    expect(result).toMatchObject({ truncated: true, matches: [{ file: "/src/a.txt", line: 1, text: "hit" }] })
    expect(result.notice).toBeDefined()
  })

  it("skips repository metadata and caches unless the caller names one as the root", async () => {
    const files = {
      "/repo/source.py": "needle",
      "/repo/.git/objects/object.py": "needle",
      "/repo/.jj/store/object.py": "needle",
      "/repo/.flows/engine.py": "needle",
      "/repo/node_modules/package.py": "needle",
      "/repo/.venv/site.py": "needle"
    }
    const broad = await execute(
      Effect.provide(Grep.run({ pattern: "needle", root: "/repo", include: "*.py" }), layer({ files }))
    )
    const explicit = await execute(
      Effect.provide(Grep.run({ pattern: "needle", root: "/repo/.git", include: "*.py" }), layer({ files }))
    )

    expect(broad).toMatchObject({
      matches: [{ file: "/repo/source.py", line: 1, text: "needle" }],
      filesSearched: 1
    })
    expect(explicit).toMatchObject({
      matches: [{ file: "/repo/.git/objects/object.py", line: 1, text: "needle" }],
      filesSearched: 1
    })
  })

  it("declares sealed hermetic effects and narrows to the root subtree", () => {
    expect(Grep.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Grep.effectsFor({ root: "/src" }).reads).toEqual(["/src/**"])
  })
})
