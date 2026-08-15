import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryError from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Fts from "../src/RecallFts.ts"

describe("RecallFts", () => {
  it("quotes each term and preserves implicit AND", () => {
    expect(Fts.literalFtsQuery("one two\" three")).toBe("\"one\" \"two\"\"\" \"three\"")
    expect(Fts.literalFtsQuery(" \0 ")).toBe("")
  })

  it("does not hide a disabled FTS namespace error", async () => {
    const error = new MemoryError.MemoryError({ code: "fts_not_enabled", message: "enable first" })
    const store = MemoryStore.MemoryStore.of({
      searchFts: () => Effect.fail(error)
    } as unknown as MemoryStore.Service)
    const exit = await Effect.runPromiseExit(
      Fts.recall({ banks: ["bank"], query: "term" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )
    expect(exit).toMatchObject({ _tag: "Failure" })
  })
})
