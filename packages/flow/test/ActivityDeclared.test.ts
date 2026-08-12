import { Activity, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Context, Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const Label = Context.Reference<string>("ActivityDeclared/Label", {
  defaultValue: () => "missing"
})

describe("Activity.make declared overload", () => {
  it("discriminates declared and inline activities by the first argument", () => {
    const declared = Activity.make("Declared/discrimination", {
      payload: { value: Schema.Number }
    })
    const inline = Activity.make({
      name: "Inline/discrimination",
      execute: Effect.void
    })

    expect(declared.name).toBe("Declared/discrimination")
    expect("payloadSchema" in declared).toBe(true)
    expect(inline.name).toBe("Inline/discrimination")
    expect("executeEncoded" in inline).toBe(true)
  })

  it("exposes declared schemas, defaults, tier, and idempotency", () => {
    const payload = Schema.Struct({ value: Schema.Number })
    const declared = Activity.make("Declared/fields", {
      payload,
      success: Schema.String,
      error: Schema.Number,
      tier: "irreversible",
      idempotencyKey: { operation: "fields" }
    })
    const defaults = Activity.make("Declared/defaults", {
      payload: { value: Schema.Number }
    })

    expect(declared.payloadSchema).toBe(payload)
    expect(declared.successSchema).toBe(Schema.String)
    expect(declared.errorSchema).toBe(Schema.Number)
    expect(declared.tier).toBe("irreversible")
    expect(declared.idempotencyKey).toEqual({ operation: "fields" })
    expect(defaults.tier).toBe("sealed")
    expect(defaults.idempotencyKey).toBeUndefined()
  })

  it("builds an activity-call node and preserves planned payload references", () => {
    const declared = Activity.make("Declared/call", {
      payload: { value: Schema.Number, nested: Schema.Struct({ label: Schema.String }) },
      success: Schema.String,
      error: Schema.Number
    })
    const value = Planned.make<number>("upstream")
    const label = Planned.make<{ readonly label: string }>("details").label
    const node = declared.call({ value, nested: { label } })

    expect(Node.isNode(node)).toBe(true)
    expect(node.ast).toEqual({
      _tag: "ActivityCall",
      activity: "Declared/call",
      payload: {
        value: { _tag: "PlannedReference", node: "upstream", path: [] },
        nested: {
          label: { _tag: "PlannedReference", node: "details", path: ["label"] }
        }
      }
    })
  })

  it("adds and merges annotations without mutating the declaration", () => {
    const original = Activity.make("Declared/annotations", {
      payload: {},
      annotations: Context.make(Label, "initial")
    })
    const annotated = original.annotate(Label, "added")
    const merged = original.annotateMerge(Context.make(Label, "merged"))

    expect(Context.get(original.annotations, Label)).toBe("initial")
    expect(Context.get(annotated.annotations, Label)).toBe("added")
    expect(Context.get(merged.annotations, Label)).toBe("merged")
  })

  it("registers an implementation that receives decoded payload and executes durably", async () => {
    const NumberPayload = Schema.Struct({ value: Schema.NumberFromString })
    const declared = Activity.make("Declared/execution", {
      payload: NumberPayload,
      success: Schema.Number,
      tier: "sealed",
      idempotencyKey: "double"
    })
    // Drive the public declared call through a composite body. This verifies
    // the ActivityCall node, its payload decoding, and the registered
    // implementation as one durable path.
    const invocation = Flow.make("Declared/execution", {
      payload: NumberPayload,
      success: Schema.Number,
      body: (payload) => declared.call(payload)
    })
    const seen: Array<number> = []
    const layer = declared.toLayer(({ value }) =>
      Effect.sync(() => {
        seen.push(value)
        return value * 2
      })
    ).pipe(Layer.provideMerge(layerMemory))

    expect(Graph.nodes(Graph.build(invocation, { value: 21 }))[0]).toMatchObject({
      kind: "ActivityCall",
      payload: { value: 21 }
    })

    const result = await runPromise(
      invocation.execute({ value: 21 }, { executionId: "declared-execution" }).pipe(
        Effect.provide(layer)
      )
    )
    expect(result).toBe(42)
    expect(seen).toEqual([21])
  })

  it("registers a flow whose body is the one call to the activity", async () => {
    const declared = Activity.make("Declared/flow-form", {
      payload: { value: Schema.Number },
      success: Schema.Number
    })
    let registered: Flow.Any | undefined
    // The registration seam is internal, so the only way to read what it files
    // is to be the runtime it files with.
    const capturing = Layer.succeed(FlowRuntime.FlowRuntime)(
      {
        register: (flow: Flow.Any) =>
          Effect.sync(() => {
            registered = flow
          })
      } as unknown as FlowRuntime.FlowRuntime["Service"]
    )

    await runPromise(
      Effect.void.pipe(
        Effect.provide(
          declared.toLayer(({ value }) => Effect.succeed(value * 2)).pipe(Layer.provideMerge(capturing))
        )
      )
    )

    expect(registered?._tag).toBe("Declared/flow-form")
    const graph = Graph.build(registered!, { value: 7 })
    expect(Graph.nodes(graph).map((node) => [node.id, node.kind])).toEqual([
      ["root.flow", "ActivityCall"],
      ["root", "FlowCall"]
    ])
    expect(Graph.nodes(graph)[0]?.payload).toEqual({ value: 7 })
  })
})
