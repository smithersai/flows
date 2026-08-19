import { Result, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import type * as KeyMaterial from "../src/KeyMaterial.ts"
import * as Node from "../src/Node.ts"

const base: KeyMaterial.KeyMaterial = {
  version: "flows/key-material/v1",
  kind: "sealed",
  body: { action: "render" },
  inputs: [],
  layers: [],
  capabilities: [],
  effects: undefined,
  placement: undefined
}

describe("KeyMaterial", () => {
  it("carries the same nondeterministic field the key compiler folds", () => {
    const recorded: KeyMaterial.KeyMaterial = { ...base, nondeterministic: true }

    expect(recorded.nondeterministic).toBe(true)
    expectTypeOf(recorded.nondeterministic).toEqualTypeOf<true | undefined>()

    // @ts-expect-error the field is a declaration, not a two-valued flag
    const denied: KeyMaterial.KeyMaterial = { ...base, nondeterministic: false }
    expect(denied.nondeterministic).toBe(false)
  })

  it("treats absence as the determinism claim, so material stays assignable without the field", () => {
    expect(base.nondeterministic).toBeUndefined()
    expect(Object.hasOwn(base, "nondeterministic")).toBe(false)
  })

  it("leaves every material a graph builds deterministic", () => {
    const flow = Flow.make({
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.String,
      body: (input) => Node.succeed(input.id)
    })
    const graph = Graph.build(Node.andThen(flow({ id: "pr" }), () => Node.succeed("done")))
    const entries = Result.getOrThrow(Graph.keyMaterial(graph))

    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.material.nondeterministic).toBeUndefined()
      expect(Object.hasOwn(entry.material, "nondeterministic")).toBe(false)
    }
  })
})
