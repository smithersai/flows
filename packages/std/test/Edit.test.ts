import { Cause, Effect, Exit, FileSystem, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Edit from "../src/Edit.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** Applies one edit and returns the file as the same host then reads it. */
const editThenRead = (
  files: Readonly<Record<string, string>>,
  input: Parameters<typeof Edit.run>[0]
) =>
  execute(Effect.provide(
    Effect.gen(function*() {
      const result = yield* Edit.run(input)
      const fileSystem = yield* FileSystem.FileSystem
      const content = yield* fileSystem.readFileString(input.path)
      return { result, content }
    }),
    layer({ files })
  ))

describe("Edit tolerant matching", () => {
  it("replaces a byte-exact block", async () => {
    const { content, result } = await editThenRead(
      { "/a.py": "def add(a, b):\n    return a - b\n" },
      { path: "/a.py", oldString: "return a - b", newString: "return a + b" }
    )
    expect(result).toMatchObject({ replacements: 1 })
    expect(content).toBe("def add(a, b):\n    return a + b\n")
  })

  it("locates a block whose file copy carries trailing whitespace", async () => {
    // The agent quotes the region from memory, and memory is
    // whitespace-lossy; the tolerant match relocates the caller's intent
    // without inventing replacement bytes.
    const { content, result } = await editThenRead(
      { "/c.py": "value = 1  \nother = 2\n" },
      { path: "/c.py", oldString: "value = 1\nother = 2", newString: "value = 3" }
    )
    expect(result).toMatchObject({ replacements: 1 })
    expect(content).toBe("value = 3\n")
  })

  it("locates a block quoted with collapsed interior spacing", async () => {
    const { content, result } = await editThenRead(
      { "/b.py": "result  =  compute( a ,  b )\n" },
      { path: "/b.py", oldString: "result = compute( a , b )", newString: "result = compute(a, b)" }
    )
    expect(result).toMatchObject({ replacements: 1 })
    expect(content).toBe("result = compute(a, b)\n")
  })

  it("reports the nearest actual region when nothing matches", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Edit.run({
        path: "/d.py",
        oldString: "def target():\n    return 9",
        newString: "x"
      })),
      layer({ files: { "/d.py": "before = 0\ndef target():\n    return 1\n" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        const message = (failure.value as { readonly message: string }).message
        expect(message).toContain("nearest actual region")
        expect(message).toContain("def target():")
      }
    }
  })

  it("still refuses an ambiguous match without replaceAll", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Edit.run({ path: "/e.py", oldString: "x = 1", newString: "x = 2" })),
      layer({ files: { "/e.py": "x = 1\nx = 1\n" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
