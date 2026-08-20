/**
 * Boundary, corner, and option-mixing cases for the cell-first controller.
 *
 * `CellTurn.test.ts` fixes the loop's ordinary contract. These cases fix its
 * edges: budgets of zero and one, a context budget that disables compaction and
 * one so small nothing is compactable, the read-only cap crossed with the frame
 * wall and with a park, steering that arrives while a cell is still running,
 * and the durable values a host may hand back malformed.
 */
import { type KeyMaterial, Placement } from "@smthrs/core"
import { Capability, Permission } from "@smthrs/kernel"
import { CanonicalJson, Model, ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Effect, type Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as Steering from "../src/Steering.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const descriptor = (
  name: string,
  overrides: {
    readonly tier?: Descriptor.EffectTier
    readonly capabilities?: ReadonlyArray<string>
    readonly writes?: ReadonlyArray<string>
  } = {}
): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: overrides.capabilities ?? [],
    effects: {
      reads: [],
      writes: overrides.writes ?? [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: overrides.tier ?? "sealed"
    },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const lister = descriptor("fs/list", { capabilities: ["fs:read:**"] })
const check = descriptor("bash", { capabilities: ["proc:spawn:*"], tier: "irreversible" })

/** A recorded model frame whose text carries one fenced cell. */
const emits = (cell: string): ScriptedModel.Step => ({
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
    ModelEvent.ModelEvent.TextDelta({
      type: "text-delta",
      id: "cell",
      text: "Here is the next step.\n\n```cell\n" + cell + "\n```"
    }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
    ModelEvent.ModelEvent.Usage({ inputTokens: 8, outputTokens: 4 }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
})

const prose = (text: string): ScriptedModel.Step => ({
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "prose" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "prose", text }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "prose" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
})

/** A settled provider step that carries no text at all. */
const silent: ScriptedModel.Step = {
  events: [
    ModelEvent.ModelEvent.Usage({ inputTokens: 1, outputTokens: 0 }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
}

const opening = (): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
    ]
  })

/** A transcript segment large enough to matter to the compaction policy. */
const bulk = (label: string, size: number): ContextWindow.SegmentInput => ({
  kind: "transcript",
  zone: "tail",
  content: [ModelRequest.Message.user(`${label}: ${"detail ".repeat(size)}`)]
})

const crowded = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    bulk("one", 6_000),
    bulk("two", 6_000),
    bulk("three", 6_000),
    bulk("four", 6_000),
    bulk("five", 6_000),
    bulk("six", 6_000)
  ]
})

const pattern = (declared: string): Capability.CapabilityPattern => {
  const parsed = declared.split(":")
  return new Capability.CapabilityPattern({
    action: `${parsed[0]}:${parsed[1]}` as Capability.PatternAction,
    resource: parsed.slice(2).join(":")
  })
}

const state = (
  overrides: {
    readonly seat?: string
    readonly frame?: number
    readonly maxFrames?: number
    readonly envelope?: ReadonlyArray<string>
    readonly readOnlyCap?: number
    readonly placement?: Option.Option<Descriptor.Placement>
    readonly contextWindow?: ContextWindow.ContextWindow
    readonly contextWindowTokens?: number
    readonly agentState?: Schema.Json
  } = {}
): CellTurn.State =>
  CellTurn.make({
    session: "session-1",
    seat: overrides.seat ?? "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: (overrides.envelope ?? ["fs:read:**"]).map(pattern),
    placement: overrides.placement ?? Option.none(),
    contextWindow: overrides.contextWindow ?? opening(),
    // Every budget below is a boundary in its own right, so an explicit zero
    // must survive to the state instead of being replaced by a default.
    frame: overrides.frame === undefined ? 0 : overrides.frame,
    maxFrames: overrides.maxFrames === undefined ? 4 : overrides.maxFrames,
    contextWindowTokens: overrides.contextWindowTokens === undefined ? 0 : overrides.contextWindowTokens,
    readOnlyCap: overrides.readOnlyCap === undefined ? 0 : overrides.readOnlyCap,
    ...(overrides.agentState === undefined ? {} : { agentState: overrides.agentState })
  })

interface Observed {
  readonly events: ReadonlyArray<AgentEvent.AgentEvent>
  /** The typed failure the run reported, when it reported one. */
  readonly failure: unknown
  /** Whether the run ended in interruption rather than a typed failure. */
  readonly interrupted: boolean
}

/**
 * Runs the loop against supplied layers, keeping every event it published.
 *
 * The typed failure and the interruption are separated deliberately: a park, a
 * budget stop, and an abort all publish events first, and a case that conflates
 * them cannot tell a cancelled run from a corrupted one.
 */
const collect = async (
  input: CellTurn.Input,
  layers: {
    readonly engine: Layer.Layer<EngineLike.EngineLike>
    readonly sandbox?: Layer.Layer<Sandbox.Sandbox> | undefined
    readonly steering?: Layer.Layer<Steering.Source> | undefined
  }
): Promise<Observed> => {
  const events: Array<AgentEvent.AgentEvent> = []
  const outcome = await CellTurn.run(input).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(layers.engine),
    Effect.provide(layers.sandbox ?? Sandbox.layerRestricted),
    Effect.provide(layers.steering ?? Steering.layerNoop()),
    Effect.result,
    Effect.exit,
    Effect.runPromise
  )
  const settled = outcome._tag === "Success" ? outcome.value : undefined
  return {
    events,
    failure: settled !== undefined && settled._tag === "Failure" ? settled.failure : undefined,
    interrupted: outcome._tag === "Failure"
  }
}

interface Run extends Observed {
  readonly engine: ScriptedEngine.Fixture
  readonly model: ScriptedModel.Fixture
}

const run = async (options: {
  readonly script: ScriptedModel.Script
  readonly calls?: ReadonlyArray<ScriptedEngine.CallStep> | undefined
  readonly flows?: ReadonlyArray<Descriptor.FlowDescriptor> | undefined
  readonly state?: CellTurn.State | undefined
  readonly limits?: Sandbox.Limits | undefined
  readonly steering?: Layer.Layer<Steering.Source> | undefined
}): Promise<Run> => {
  const model = ScriptedModel.make(options.script)
  const engine = ScriptedEngine.make(model.model, [], options.calls ?? [])
  const observed = await collect(
    {
      state: options.state ?? state(),
      flows: options.flows ?? [lister],
      limits: options.limits
    },
    { engine: engine.layer, steering: options.steering }
  )
  return { ...observed, engine, model }
}

/**
 * An engine whose flow calls are supplied by the case itself.
 *
 * The scripted fixture always settles a failure with a message and a success
 * with a value; a host engine is ordinary JavaScript and need not. These cases
 * hand back exactly what a sloppy host would.
 */
const stubEngine = (
  model: Model.Model,
  overrides: {
    readonly call?: ((call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>) | undefined
  } = {}
) => {
  const calls: Array<Cell.Call> = []
  const suspended: Array<EngineLike.SuspendReason> = []
  const engine = EngineLike.make({
    sealStep: (step) => model.stream(step.request),
    splice: () => Stream.empty,
    call: (call) => {
      calls.push(call)
      return overrides.call === undefined
        ? Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
        : overrides.call(call)
    },
    record: (boundary) => boundary.execute,
    suspend: (reason) => {
      suspended.push(reason)
      return Effect.fail(new HarnessError({ code: "suspended", message: reason.message, cause: reason }))
    }
  })
  return { engine, layer: EngineLike.layer(engine), calls, suspended }
}

/**
 * The result a host engine settled without a value.
 *
 * The port's type says the value is JSON, and nothing at the boundary enforces
 * it. The frame must still summarize such a call rather than fail on a value
 * that will not serialize.
 */
const valueless = (): Cell.CallResult =>
  Object.assign(new Cell.CallResult({ outcome: "success", value: null }), { value: undefined as never })

const of = <T extends AgentEvent.AgentEvent["_tag"]>(
  events: ReadonlyArray<AgentEvent.AgentEvent>,
  tag: T
): ReadonlyArray<Extract<AgentEvent.AgentEvent, { readonly _tag: T }>> =>
  events.filter((event): event is Extract<AgentEvent.AgentEvent, { readonly _tag: T }> => event._tag === tag)

const messagesOf = (model: ScriptedModel.Fixture, index: number): string =>
  JSON.stringify(model.recorder.requests[index]?.messages ?? [])

/** Only what the harness itself said to the model on one request. */
const observationsOf = (model: ScriptedModel.Fixture, index: number): string =>
  (model.recorder.requests[index]?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.content.map((part) => part.text).join(""))
    .join("\n")

const resolvedText = (events: ReadonlyArray<AgentEvent.AgentEvent>): string => {
  const part = of(events, "resolved")[0]?.message.content[0]
  return part?.type === "text" ? part.text : ""
}

describe("CellTurn seat and placement", () => {
  it("keys a sealed step on every placement a run may declare, and on none when it declares none", async () => {
    const declared: ReadonlyArray<readonly [Descriptor.Placement, Placement.Placement]> = [
      ["client", Placement.client()],
      ["local", Placement.local()],
      ["remote", Placement.remote()],
      ["sandbox", Placement.sandbox()]
    ]
    for (const [value, expected] of declared) {
      const { engine } = await run({
        script: [emits(`return { intent: "complete", output: "done" }`)],
        state: state({ placement: Option.some(value) })
      })
      expect(engine.recorder.sealStep[0]?.keyMaterial.placement).toEqual(expected)
    }

    // No placement at all is its own case: the key material omits the field
    // rather than defaulting to a host, so an unplaced run keys differently
    // from one pinned to the local process.
    const { engine } = await run({ script: [emits(`return { intent: "complete", output: "done" }`)] })
    expect(engine.recorder.sealStep[0]?.keyMaterial.placement).toBeUndefined()
  })

  it("reads a seat that names no provider as the whole model id", async () => {
    const { model } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ seat: "bare-model" })
    })

    expect(model.recorder.requests[0]?.modelId).toBe("bare-model")
  })

  it("takes only the segment after the first colon of a provider-qualified seat", async () => {
    const { model } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ seat: "bedrock:us.anthropic:claude" })
    })

    expect(model.recorder.requests[0]?.modelId).toBe("us.anthropic:claude")
  })
})

describe("CellTurn durable state teaching", () => {
  it("prints a state of exactly the printable limit in full, and rosters the byte over it", async () => {
    const printable = { plan: "x".repeat(2_037) }
    expect(CanonicalJson.stringify(printable).length).toBe(2_048)
    const printed = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ agentState: printable })
    })
    expect(printed.model.recorder.requests[0]?.system.at(-1)?.text).toBe(
      `Agent-owned durable state for this frame (JSON), also available in the cell as ctx.state:\n${
        CanonicalJson.stringify(printable)
      }`
    )

    const oversized = { plan: "x".repeat(2_038) }
    expect(CanonicalJson.stringify(oversized).length).toBe(2_049)
    const rostered = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ agentState: oversized })
    })
    const teaching = rostered.model.recorder.requests[0]?.system.at(-1)?.text ?? ""
    expect(teaching).toContain("durable state for this frame is 2049 bytes")
    expect(teaching).toContain("- plan (2040 bytes)")
    // The point of the roster is that the bytes are not paid twice.
    expect(teaching).not.toContain("x".repeat(2_038))
  })

  it("rosters every key of an oversized state, whatever each key holds", async () => {
    const { model } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({
        agentState: { notes: "y".repeat(3_000), counts: [1, 2, 3], empty: null, flag: true }
      })
    })

    const teaching = model.recorder.requests[0]?.system.at(-1)?.text ?? ""
    expect(teaching).toContain("- notes (3002 bytes)")
    expect(teaching).toContain("- counts (7 bytes)")
    expect(teaching).toContain("- empty (4 bytes)")
    expect(teaching).toContain("- flag (4 bytes)")
  })

  it("reports only the size of an oversized state that has no keys to roster", async () => {
    const array = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ agentState: ["z".repeat(3_000)] })
    })
    expect(array.model.recorder.requests[0]?.system.at(-1)?.text).toContain("(3004 bytes)")

    const scalar = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ agentState: "z".repeat(3_000) })
    })
    expect(scalar.model.recorder.requests[0]?.system.at(-1)?.text).toContain("(3002 bytes)")
  })

  it("prints an absent state as the literal null the cell will see", async () => {
    const { model } = await run({ script: [emits(`return { intent: "complete", output: "done" }`)] })

    expect(model.recorder.requests[0]?.system.at(-1)?.text).toBe(
      "Agent-owned durable state for this frame (JSON), also available in the cell as ctx.state:\nnull"
    )
  })
})

describe("CellTurn frame budget", () => {
  it("spends one frame on a budget of zero and stops on the budget message", async () => {
    const { events, model } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`)
      ],
      state: state({ maxFrames: 0 })
    })

    // A budget of zero still buys the frame already in flight; what it forbids
    // is the next one.
    expect(model.recorder.requests).toHaveLength(1)
    expect(resolvedText(events)).toContain("frame budget of 0 is exhausted")
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("resolved")
  })

  it("spends exactly one frame on a budget of one", async () => {
    const { events, model } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "complete", output: "never reached" }`)
      ],
      state: state({ maxFrames: 1 })
    })

    expect(model.recorder.requests).toHaveLength(1)
    expect(resolvedText(events)).toContain("frame budget of 1 is exhausted")
  })

  it("spends the whole budget and never the frame past it", async () => {
    const { model } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "complete", output: "never reached" }`)
      ],
      state: state({ maxFrames: 3 })
    })

    expect(model.recorder.requests).toHaveLength(3)
    // The budget never changes what a frame may use: no frame, final one
    // included, declares a provider tool.
    expect(model.recorder.requests.map((request) => [request.tools, request.toolChoice])).toEqual([
      [[], "none"],
      [[], "none"],
      [[], "none"]
    ])
  })

  it("stops at the budget after a frame that threw, and still resolves on the budget message", async () => {
    const { events } = await run({
      script: [emits(`throw new RangeError("off by one")`)],
      state: state({ maxFrames: 1 })
    })

    expect(of(events, "cell-settled")[0]?.outcome._tag).toBe("raised")
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("resolved")
    expect(resolvedText(events)).toContain("frame budget of 1 is exhausted")
  })
})

describe("CellTurn context budget", () => {
  it("leaves a crowded window alone when the context budget dwarfs it", async () => {
    const { engine, events } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ contextWindow: crowded, contextWindowTokens: 1_000_000, maxFrames: 2 }),
      flows: []
    })

    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(of(events, "compaction-settled")).toHaveLength(0)
  })

  it("leaves a window alone when a tiny budget crosses the threshold but nothing is compactable", async () => {
    const { engine, events } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      // A budget of one token is over threshold on any window at all, and this
      // window's whole transcript is recent enough to keep: a window that has
      // already given up everything it can is not a failure.
      state: state({ contextWindowTokens: 1, maxFrames: 2 })
    })

    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(of(events, "compaction-settled")).toHaveLength(0)
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("compacts under a tiny budget and keeps the whole recent suffix", async () => {
    const { engine, events } = await run({
      script: [prose("the compacted summary"), emits(`return { intent: "complete", output: "done" }`)],
      state: state({ contextWindow: crowded, contextWindowTokens: 1, maxFrames: 2 }),
      flows: []
    })

    expect(engine.recorder.sealStep).toHaveLength(2)
    const settled = of(events, "compaction-settled")
    expect(settled).toHaveLength(1)
    expect(settled[0]?.replacedPrefixDigest).toBe(
      Result.getOrThrow(ContextWindow.prefixDigest(crowded, 4))
    )
  })

  it("charges compaction to the sealed-step ledger and never to the frame budget", async () => {
    const { engine, model } = await run({
      script: [prose("the compacted summary"), emits(`return { intent: "complete", output: "done" }`)],
      state: state({ contextWindow: crowded, contextWindowTokens: 40_000, maxFrames: 1 }),
      flows: []
    })

    // Two sealed steps, one frame: a budget of one still gets its whole model
    // turn after the summary lands.
    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(model.recorder.requests).toHaveLength(2)
  })

  it("fails the frame when the sealed compaction step never settles", async () => {
    const { events, failure } = await run({
      script: [
        { events: [ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "partial" })] },
        emits(`return { intent: "complete", output: "done" }`)
      ],
      state: state({ contextWindow: crowded, contextWindowTokens: 40_000, maxFrames: 2 }),
      flows: []
    })

    expect(failure).toMatchObject({
      code: "model_failed",
      message: "The sealed compaction step ended without a recorded settlement"
    })
    // Compaction runs before the turn opens, so the frame never opened one.
    expect(of(events, "turn-opened")).toHaveLength(0)
  })

  it("fails the frame when the sealed compaction step returns no text summary", async () => {
    const { events, failure } = await run({
      script: [silent, emits(`return { intent: "complete", output: "done" }`)],
      state: state({ contextWindow: crowded, contextWindowTokens: 40_000, maxFrames: 2 }),
      flows: []
    })

    expect(failure).toMatchObject({
      code: "model_failed",
      message: "The sealed compaction step returned no text summary"
    })
    expect(of(events, "compaction-settled")).toHaveLength(0)
    expect(of(events, "turn-opened")).toHaveLength(0)
  })
})

describe("CellTurn call classification", () => {
  it("cannot be told a call writes by an input that is not an object", async () => {
    const { model } = await run({
      state: state({ readOnlyCap: 2, maxFrames: 4, envelope: ["fs:read:**"] }),
      flows: [lister],
      script: [
        emits(
          `await ctx.call("fs/list", ["writes"])
           return { intent: "continue", state: {}, context: [{ role: "user", text: "listed" }] }`
        ),
        emits(
          `await ctx.call("fs/list", "writes")
           return { intent: "continue", state: {}, context: [{ role: "user", text: "listed" }] }`
        ),
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "continue", state: {}, context: [] }`)
      ],
      calls: [{ _tag: "Success", value: [] }, { _tag: "Success", value: [] }]
    })

    // An array and a bare string carry no declaration the loop can read, so
    // both frames stayed read-only and the cap spoke on schedule.
    expect(messagesOf(model, 1)).not.toContain("Read-only discipline")
    expect(messagesOf(model, 2)).toContain("Read-only discipline")
  })

  it("counts an empty declared write set as no write at all", async () => {
    const { model } = await run({
      state: state({ readOnlyCap: 1, maxFrames: 4, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        emits(
          `await ctx.call("bash", { command: "pytest", writes: [] })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "ran" }] }`
        ),
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "continue", state: {}, context: [] }`)
      ],
      calls: [{ _tag: "Success", value: { exitCode: 0 } }]
    })

    expect(messagesOf(model, 1)).toContain("Read-only discipline")
  })

  it("clips a huge call result out of the next frame's salvage note", async () => {
    const { model } = await run({
      flows: [lister],
      script: [
        emits(
          `await ctx.call("fs/list", { path: "." })
           throw new Error("lost the thread")`
        ),
        emits(`return { intent: "complete", output: "recovered" }`)
      ],
      calls: [{ _tag: "Success", value: "w".repeat(5_000) }]
    })

    const salvage = messagesOf(model, 1)
    expect(salvage).toContain("Calls this cell already completed")
    expect(salvage).toContain("…")
    // The whole payload is durable behind the call boundary; the transcript
    // carries a bounded summary of it, not the payload.
    expect(salvage).not.toContain("w".repeat(1_000))
  })

  it("names a failed call in the salvage note even when the host gave no message", async () => {
    const model = ScriptedModel.make([
      emits(
        `try { await ctx.call("fs/list", { path: "." }) } catch (error) {}
         throw new Error("lost the thread")`
      ),
      emits(`return { intent: "complete", output: "recovered" }`)
    ])
    const engine = stubEngine(model.model, {
      call: () => Effect.succeed(new Cell.CallResult({ outcome: "failure", value: null }))
    })
    const { events } = await collect({ state: state(), flows: [lister] }, { engine: engine.layer })

    expect(of(events, "cell-call-settled")[0]?.result.outcome).toBe("failure")
    expect(messagesOf(model, 1)).toContain("fs/list -> FAILED: failed")
    expect(resolvedText(events)).toBe("recovered")
  })

  it("summarizes a call the host settled without a value rather than failing on it", async () => {
    const model = ScriptedModel.make([
      emits(
        `await ctx.call("fs/list", { path: "." })
         throw new Error("lost the thread")`
      ),
      emits(`return { intent: "complete", output: "recovered" }`)
    ])
    const engine = stubEngine(model.model, { call: () => Effect.succeed(valueless()) })
    const { events } = await collect({ state: state(), flows: [lister] }, { engine: engine.layer })

    expect(messagesOf(model, 1)).toContain("fs/list -> ok: null")
    expect(resolvedText(events)).toBe("recovered")
  })

  it("settles a frame that makes no call at all", async () => {
    const { engine, events } = await run({
      script: [emits(`return { intent: "complete", output: "nothing to run" }`)]
    })

    expect(engine.recorder.calls).toHaveLength(0)
    expect(of(events, "cell-call-started")).toHaveLength(0)
    expect(of(events, "cell-call-settled")).toHaveLength(0)
    expect(resolvedText(events)).toBe("nothing to run")
  })

  it("gives four calls in one cell four consecutive ordinals", async () => {
    const { engine } = await run({
      script: [
        emits(
          `for (const path of ["a", "b", "c", "d"]) await ctx.call("fs/list", { path })
           return { intent: "complete", output: "done" }`
        )
      ],
      calls: [
        { _tag: "Success", value: [] },
        { _tag: "Success", value: [] },
        { _tag: "Success", value: [] },
        { _tag: "Success", value: [] }
      ]
    })

    expect(engine.recorder.calls.map((call) => [call.identity.ordinal, call.input])).toEqual([
      [0, { path: "a" }],
      [1, { path: "b" }],
      [2, { path: "c" }],
      [3, { path: "d" }]
    ])
  })
})

describe("CellTurn discipline interaction", () => {
  it("stops a run at twice the read-only cap before its completion is ever considered", async () => {
    const { events, failure } = await run({
      state: state({ readOnlyCap: 1, maxFrames: 6, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        emits(
          `await ctx.call("bash", { command: "grep -r todo ." })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "still reading" }] }`
        ),
        emits(`return { intent: "complete", state: {}, output: "implemented the fix" }`)
      ],
      calls: [{ _tag: "Success", value: { exitCode: 0 } }]
    })

    // The cap is judged before the completion block, so a run that never wrote
    // anything cannot buy its way past the hard stop with a claim.
    expect(failure).toMatchObject({ code: "read_only_cap" })
    expect(of(events, "resolved")).toHaveLength(0)
  })

  it("exempts a park from the read-only cap", async () => {
    const { events, failure } = await run({
      state: state({ readOnlyCap: 1, maxFrames: 6 }),
      flows: [lister],
      script: [
        emits(
          `await ctx.call("fs/list", { path: "." })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "still reading" }] }`
        ),
        emits(
          `await ctx.call("fs/list", { path: "." })
           return { intent: "park", state: {}, reason: "waiting-input", message: "which branch?" }`
        )
      ],
      calls: [{ _tag: "Success", value: [] }, { _tag: "Success", value: [] }]
    })

    // Two read-only frames is twice a cap of one, and the run still parked:
    // waiting is not evasion, and a parked run reports nothing as done.
    expect(failure).toMatchObject({ code: "suspended" })
    expect(of(events, "suspended")[0]?.reason.code).toBe("waiting-input")
    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 1,
      cap: 1,
      nextFrame: 1,
      nextAction: "park"
    })
  })

  it("records the write when a demanded frame edits and then parks", async () => {
    const { events, failure } = await run({
      state: state({ readOnlyCap: 1, maxFrames: 6, envelope: ["fs:read:**", "fs:write:**"] }),
      flows: [lister, descriptor("edit", { capabilities: ["fs:write:**"], writes: ["/**"] })],
      script: [
        emits(
          `await ctx.call("fs/list", { path: "." })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "still reading" }] }`
        ),
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           return { intent: "park", state: {}, reason: "waiting-input", message: "is this the right fix?" }`
        )
      ],
      calls: [{ _tag: "Success", value: [] }, { _tag: "Success", value: { edited: true } }]
    })

    // The demand is answered by what the frame did, not by how it ended: an
    // edit that landed before the park is recorded as a write.
    expect(failure).toMatchObject({ code: "suspended" })
    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 1,
      cap: 1,
      nextFrame: 1,
      nextAction: "write"
    })
  })

  it("arms the discipline with the limits the host declared, defaulting only what it omitted", async () => {
    const { events } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ maxFrames: 7, readOnlyCap: 3 }),
      limits: { calls: 5 }
    })

    expect(of(events, "discipline-armed")[0]).toMatchObject({
      readOnlyCap: 3,
      maxFrames: 7,
      calls: 5,
      callMs: Sandbox.defaultLimits.callMs
    })
  })

  it("does not re-arm the discipline when a resumed run re-enters past its first frame", async () => {
    const { engine, events } = await run({
      script: [
        emits(
          `await ctx.call("fs/list", { path: "." })
           return { intent: "complete", output: "done" }`
        )
      ],
      state: state({ frame: 2, maxFrames: 6 }),
      calls: [{ _tag: "Success", value: [] }]
    })

    // A second arming record would make the gate count runs instead of arming
    // decisions, so a resumed frame publishes none.
    expect(of(events, "discipline-armed")).toHaveLength(0)
    expect(events[0]?._tag).toBe("turn-opened")
    expect(engine.recorder.calls[0]?.identity.frame).toBe(2)
  })
})

describe("CellTurn steering boundaries", () => {
  const source = (drain: () => Steering.Drain): Layer.Layer<Steering.Source> =>
    Steering.layer({
      read: () => Effect.succeed(Steering.empty()),
      drain: () => Effect.sync(drain)
    })

  const nothing: Steering.Drain = {
    inserts: [],
    seatChanges: [],
    activatedToolNames: [],
    remaining: Steering.empty(),
    queued: false
  }

  it("journals an empty drain at every continuing boundary", async () => {
    const { engine, events } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "next" }] }`),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    // Nothing to deliver is still a read of the world, so the boundary is
    // recorded rather than skipped.
    expect(of(events, "steering-drained").map((event) => event.messages)).toEqual([[]])
    expect(engine.recorder.records.map((record) => record.name)).toEqual(["steering-drain"])
  })

  it("delivers steering that arrived mid-frame at the next frame boundary", async () => {
    const model = ScriptedModel.make([
      emits(
        `await ctx.call("fs/list", { path: "." })
         return { intent: "continue", state: null, context: [{ role: "user", text: "kept" }] }`
      ),
      emits(`return { intent: "complete", output: "done" }`)
    ])
    const arrived: Array<ModelRequest.Message> = []
    const engine = stubEngine(model.model, {
      call: () =>
        Effect.sync(() => {
          // A human steers while the cell is still resolving its calls.
          arrived.push(ModelRequest.Message.user("steer: prefer the shorter route"))
          return new Cell.CallResult({ outcome: "success", value: [] })
        })
    })
    const steering = source(() => {
      const inserts = [...arrived]
      arrived.length = 0
      return { ...nothing, inserts }
    })
    const { events } = await collect(
      { state: state(), flows: [lister] },
      { engine: engine.layer, steering }
    )

    // It never reached the frame it arrived during; it landed whole at the
    // boundary, after the cell's own projected context.
    expect(model.recorder.requests[0]?.messages).toEqual([ModelRequest.Message.user("start")])
    expect(of(events, "steering-drained")[0]?.messages).toEqual([
      ModelRequest.Message.user("steer: prefer the shorter route")
    ])
    expect(model.recorder.requests[1]?.messages).toEqual([
      ModelRequest.Message.user("kept"),
      ModelRequest.Message.user("steer: prefer the shorter route")
    ])
  })

  it("applies a thinking change without a seat change, and ignores an activated tool", async () => {
    const model = ScriptedModel.make([
      emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "kept" }] }`),
      emits(`return { intent: "complete", output: "done" }`)
    ])
    const engine = ScriptedEngine.make(model.model, [], [])
    let drained = false
    const steering = source(() => {
      if (drained) return nothing
      drained = true
      return {
        ...nothing,
        seatChanges: [{ _tag: "ThinkingChange", delivery: "steer", admittedAt: 1, thinking: "xhigh" }],
        activatedToolNames: ["alpha"]
      }
    })
    const { events } = await collect({ state: state(), flows: [] }, { engine: engine.layer, steering })

    expect(model.recorder.requests[1]?.modelId).toBe("test-model")
    expect(model.recorder.requests[1]?.params.reasoningEffort).toBe("xhigh")
    // A cell-first frame has no provider tools to activate, so the request and
    // the opened turn both stay empty of them.
    expect(model.recorder.requests[1]?.tools).toEqual([])
    expect(of(events, "turn-opened").map((event) => event.activeToolNames)).toEqual([[], []])
  })

  it("keeps the last of two seat changes drained at one boundary", async () => {
    const model = ScriptedModel.make([
      emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "kept" }] }`),
      emits(`return { intent: "complete", output: "done" }`)
    ])
    const engine = ScriptedEngine.make(model.model, [], [])
    let drained = false
    const steering = source(() => {
      if (drained) return nothing
      drained = true
      return {
        ...nothing,
        seatChanges: [
          { _tag: "SeatChange", delivery: "steer", admittedAt: 1, seat: "openai:first-model" },
          { _tag: "SeatChange", delivery: "steer", admittedAt: 2, seat: "openai:second-model" }
        ]
      }
    })
    await collect({ state: state(), flows: [] }, { engine: engine.layer, steering })

    // Seat changes are applied in admission order, so the newest one wins and
    // the window it re-keys is the one the next frame actually renders.
    expect(model.recorder.requests[1]?.modelId).toBe("second-model")
  })
})

describe("CellTurn frame failures", () => {
  it("reports a sandbox binding that cannot honour a declared limit as an engine failure", async () => {
    const { events, failure } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      // The restricted binding enforces no heap ceiling, so an explicit one is
      // refused rather than silently ignored.
      limits: { memoryBytes: Sandbox.minimumMemoryBytes }
    })

    expect(failure).toMatchObject({ code: "engine_failed", message: "The cell frame failed" })
    expect((failure as HarnessError).cause).toMatchObject({ code: "unsupported" })
    // The turn had already opened and the model had already settled, so the
    // frame's evidence survives the failure.
    expect(of(events, "model-settled")).toHaveLength(1)
  })

  it("reports a provider failure that is not a harness error as a model failure", async () => {
    const { events, failure } = await run({
      script: [emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`)],
      state: state({ maxFrames: 3 })
    })

    // The script has one step and the budget has three frames: the second
    // frame's provider call fails outright.
    expect(failure).toMatchObject({ code: "model_failed", message: "The cell frame failed" })
    expect((failure as HarnessError).cause).toMatchObject({ code: "invalid_provider_output" })
    expect(of(events, "turn-opened")).toHaveLength(2)
  })

  it("parks when the sealed model step itself raises the permission request", async () => {
    const request = new Permission.PermissionRequired({
      requestId: "perm-seal",
      capability: Capability.make("model:call", "anthropic/*"),
      tier: "irreversible",
      meta: {}
    })
    const provider = Model.make({ stream: () => Stream.fail(request) })
    const engine = stubEngine(provider)
    const { events } = await collect({ state: state(), flows: [] }, { engine: engine.layer })

    // The request arrives unwrapped, straight off the model port's own failure
    // channel, and still parks durably rather than crashing the run.
    expect(of(events, "permission-required")[0]?.request.requestId).toBe("perm-seal")
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("suspended")
    expect(of(events, "suspended")[0]?.reason).toMatchObject({
      code: "permission-required",
      message: "Permission perm-seal is required"
    })
    expect(engine.suspended.map((reason) => reason.code)).toEqual(["permission-required"])
  })

  it("parks when a permission request arrives as plain data rather than as an instance", async () => {
    const request = new Permission.PermissionRequired({
      requestId: "perm-json",
      capability: Capability.make("proc:spawn", "**"),
      tier: "irreversible",
      meta: {}
    })
    const encoded = Schema.encodeUnknownSync(Permission.PermissionRequired)(request)
    const model = ScriptedModel.make([
      emits(
        `await ctx.call("fs/list", { path: "." })
         return { intent: "complete", output: "unreachable" }`
      )
    ])
    const engine = stubEngine(model.model, {
      call: () =>
        Effect.fail(
          new HarnessError({ code: "engine_failed", message: "Permission required", cause: encoded })
        )
    })
    const { events } = await collect({ state: state(), flows: [lister] }, { engine: engine.layer })

    // A journal hands back JSON, not class instances, so a resumed run must
    // still recognize the park it is being asked for.
    expect(of(events, "permission-required")[0]?.request.requestId).toBe("perm-json")
    expect(of(events, "suspended")[0]?.reason.code).toBe("permission-required")
  })

  it("reports a durable context window that no longer renders as a typed render failure", async () => {
    // A context window is durable state a host rehydrates. One whose transcript
    // no longer validates has to be stated as a render failure rather than
    // crash the frame it was handed to.
    const corrupt = ContextWindow.make({
      modelId: "test-model",
      segments: [{ kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }]
    })
    ;(corrupt.segments[0]!.content as Array<unknown>)[0] = { role: "user" }
    const { events, failure } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: state({ contextWindow: corrupt })
    })

    expect(failure).toMatchObject({
      code: "render_failed",
      message: "Unable to render the context window"
    })
    // The turn opened before the request was assembled, so the frame is on the
    // record with the digest it failed on.
    expect(of(events, "turn-opened")).toHaveLength(1)
    expect(of(events, "model-settled")).toHaveLength(0)
  })
})

describe("CellTurn interruption", () => {
  it("reports one well-formed abort when the provider stream is interrupted mid-frame", async () => {
    const model = ScriptedModel.make([{ ...ScriptedModel.midStreamInterrupt }])
    const engine = ScriptedEngine.make(model.model, [], [])
    const { events, interrupted } = await collect({ state: state(), flows: [] }, { engine: engine.layer })

    expect(interrupted).toBe(true)
    expect(of(events, "turn-opened")).toHaveLength(1)
    expect(of(events, "aborted")).toHaveLength(1)
    expect(of(events, "turn-closed").at(-1)).toMatchObject({ stopReason: "aborted", outcome: "aborted" })
  })

  it("reports one well-formed abort when a frame is interrupted at its closing boundary", async () => {
    const model = ScriptedModel.make([
      emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "next" }] }`),
      emits(`return { intent: "complete", output: "unreachable" }`)
    ])
    const engine = ScriptedEngine.make(model.model, [], [])
    const steering = Steering.layer({
      read: () => Effect.succeed(Steering.empty()),
      drain: () => Effect.interrupt
    })
    const { events, interrupted } = await collect(
      { state: state(), flows: [] },
      { engine: engine.layer, steering }
    )

    // The transition was applied before the drain, so cancellation loses the
    // frame's next context and nothing that was already settled.
    expect(interrupted).toBe(true)
    expect(of(events, "transition-applied")).toHaveLength(1)
    expect(of(events, "aborted")).toHaveLength(1)
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("aborted")
    expect(of(events, "resolved")).toHaveLength(0)
  })
})

describe("CellTurn replay", () => {
  it("seals identical requests and identical call identities when the same state is re-entered", async () => {
    const script = (): ScriptedModel.Script => [
      emits(
        `await ctx.call("fs/list", { path: "." })
         return { intent: "continue", state: { seen: 1 }, context: [{ role: "user", text: "again" }] }`
      ),
      emits(
        `await ctx.call("fs/list", { path: "src" })
         return { intent: "complete", state: { seen: 2 }, output: "done" }`
      )
    ]
    const calls: ReadonlyArray<ScriptedEngine.CallStep> = [
      { _tag: "Success", value: ["alpha.md"] },
      { _tag: "Success", value: ["beta.md"] }
    ]
    const original = state({ agentState: { plan: ["one"] } })
    const first = await run({ script: script(), calls, state: original })

    // The controller's whole carried state is serializable, so a resumed run
    // starts from the decoded value rather than from the object in memory.
    const rehydrated = Schema.decodeUnknownSync(CellTurn.State)(
      Schema.encodeUnknownSync(CellTurn.State)(original)
    )
    const second = await run({ script: script(), calls, state: rehydrated })

    const requests = (fixture: Run) => fixture.model.recorder.requests
    expect(requests(second)).toEqual(requests(first))
    const material = (fixture: Run): ReadonlyArray<KeyMaterial.KeyMaterial> =>
      fixture.engine.recorder.sealStep.map((step) => step.keyMaterial)
    expect(material(second)).toEqual(material(first))
    const identities = (fixture: Run) => fixture.engine.recorder.calls.map((call) => call.identity)
    expect(identities(second)).toEqual(identities(first))
    expect(resolvedText(second.events)).toBe("done")
  })

  it("keys the steering-drain boundary on the frame it belongs to, not on the run", async () => {
    const { engine } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "one" }] }`),
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "two" }] }`),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    const identities = engine.recorder.records.map((record) => record.identity)
    expect(identities.map((identity) => identity.frame)).toEqual([0, 1])
    // Two frames, two distinct boundaries: a replay of frame one cannot serve
    // frame zero's recorded drain.
    expect(new Set(identities.map((identity) => identity.boundary)).size).toBe(2)
  })
})
