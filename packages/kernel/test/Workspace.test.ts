import { Effect } from "effect"
import { sep } from "node:path"
import { describe, expect, it } from "vitest"
import * as Workspace from "../src/Workspace.ts"

describe("Workspace", () => {
  it.each(
    [
      ["an empty root", ""],
      ["a relative root", "work/tree"],
      ["a trailing platform separator", `work${sep}`]
    ] as const
  )("preserves %s as policy configuration", (_name, root) => {
    expect(Workspace.make(root).root).toBe(root)
  })

  it("provides the exact configured root through its layer", async () => {
    const root = `relative${sep}`
    const configured = await Effect.runPromise(
      Effect.gen(function*() {
        const workspace = yield* Workspace.Workspace
        return workspace.root
      }).pipe(Effect.provide(Workspace.layer(root)))
    )

    expect(configured).toBe(root)
    expect(Workspace.makeNoop.root).toBe(".")
  })
})
