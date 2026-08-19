/**
 * The cell-first controller, driven by a recorded model.
 *
 * These cases fix the loop's contract: continuation comes from the transition
 * a cell returned, every flow call is its own boundary with its own identity,
 * and an unusable cell is durable evidence rather than a crash.
 */
import { Capability, Permission } from "@smthrs/kernel"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Effect, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import type * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as Compaction from "../src/Compaction.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as Steering from "../src/Steering.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const descriptor = (
  name: string,
  overrides: {
    readonly tier?: Descriptor.EffectTier
    readonly capabilities?: ReadonlyArray<string>
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
      writes: [],
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

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
  ]
})

const state = (overrides: { readonly maxFrames?: number; readonly envelope?: ReadonlyArray<string> } = {}) =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: (overrides.envelope ?? ["fs:read:**"]).map((pattern) => {
      const parsed = pattern.split(":")
      return new Capability.CapabilityPattern({
        action: `${parsed[0]}:${parsed[1]}` as Capability.PatternAction,
        resource: parsed.slice(2).join(":")
      })
    }),
    placement: Option.none(),
    contextWindow: window,
    maxFrames: overrides.maxFrames ?? 4
  })

interface Run {
  readonly events: ReadonlyArray<AgentEvent.AgentEvent>
  readonly engine: ScriptedEngine.Fixture
  readonly model: ScriptedModel.Fixture
  readonly failure?: unknown
}

const run = async (options: {
  readonly script: ScriptedModel.Script
  readonly calls?: ReadonlyArray<ScriptedEngine.CallStep>
  readonly flows?: ReadonlyArray<Descriptor.FlowDescriptor>
  readonly state?: CellTurn.State
}): Promise<Run> => {
  const model = ScriptedModel.make(options.script)
  const engine = ScriptedEngine.make(model.model, [], options.calls ?? [])
  const events: Array<AgentEvent.AgentEvent> = []
  // Collected event-by-event so a run that ends in a park or a failure is still
  // observed through everything it published first.
  const outcome = await CellTurn.run({
    state: options.state ?? state(),
    flows: options.flows ?? [descriptor("fs/list", { capabilities: ["fs:read:**"] })]
  }).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(engine.layer),
    Effect.provide(Sandbox.layerRestricted),
    Effect.provide(Steering.layerNoop()),
    Effect.result,
    Effect.runPromise
  )
  return { events, engine, model, failure: outcome._tag === "Failure" ? outcome.failure : undefined }
}

const of = <T extends AgentEvent.AgentEvent["_tag"]>(
  events: ReadonlyArray<AgentEvent.AgentEvent>,
  tag: T
): ReadonlyArray<Extract<AgentEvent.AgentEvent, { readonly _tag: T }>> =>
  events.filter((event): event is Extract<AgentEvent.AgentEvent, { readonly _tag: T }> => event._tag === tag)

describe("CellTurn", () => {
  it("runs two data-dependent calls in one frame and completes the returned transition", async () => {
    const { engine, events, model } = await run({
      script: [
        emits(
          `const listed = await ctx.call("fs/list", { path: "." })
           const detail = await ctx.call("fs/read", { path: listed[0] })
           return { intent: "complete", state: { read: listed[0] }, output: detail }`
        )
      ],
      flows: [
        descriptor("fs/list", { capabilities: ["fs:read:**"] }),
        descriptor("fs/read", { capabilities: ["fs:read:**"] })
      ],
      calls: [
        { _tag: "Success", value: ["alpha.md", "beta.md"] },
        { _tag: "Success", value: "the contents of alpha" }
      ]
    })

    // One model round trip, two flow calls: the second call's input came from
    // the first call's result without going back to the provider.
    expect(model.recorder.requests).toHaveLength(1)
    expect(engine.recorder.calls.map((call) => [call.flowName, call.input])).toEqual([
      ["fs/list", { path: "." }],
      ["fs/read", { path: "alpha.md" }]
    ])
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      ModelRequest.TextPart.make({ text: "the contents of alpha" })
    ])

    // Two distinct call boundaries, and nothing that looks like an opaque
    // whole-cell activity.
    expect(of(events, "cell-call-started")).toHaveLength(2)
    expect(of(events, "cell-call-settled")).toHaveLength(2)
    expect(of(events, "elaborated")).toHaveLength(0)
    expect(of(events, "child-result")).toHaveLength(0)
    expect(engine.recorder.splice).toHaveLength(0)
  })

  it("gives every call in a cell a distinct identity that cannot alias", async () => {
    const { engine } = await run({
      script: [
        emits(
          `await ctx.call("fs/list", { path: "." })
           await ctx.call("fs/list", { path: "." })
           return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`
        ),
        emits(
          `await ctx.call("fs/list", { path: "." })
           return { intent: "complete", output: "done" }`
        )
      ],
      calls: [
        { _tag: "Success", value: [] },
        { _tag: "Success", value: [] },
        { _tag: "Success", value: [] }
      ]
    })

    const identities = engine.recorder.calls.map((call) => call.identity)
    // Identical arguments and declaration; only the position differs.
    expect(identities.map((identity) => [identity.frame, identity.ordinal])).toEqual([[0, 0], [0, 1], [1, 0]])
    expect(new Set(identities.map((identity) => identity.cell)).size).toBe(2)
    expect(identities.every((identity) => identity.session === "session-1")).toBe(true)
    expect(identities.every((identity) => identity.layers.length === 1)).toBe(true)
    // The declaration digest is the flow's, so the same flow keys the same way.
    expect(new Set(identities.map((identity) => identity.declaration)).size).toBe(1)
  })

  it("carries agent-selected state and the exact next context into the following frame", async () => {
    const { events, model } = await run({
      script: [
        emits(
          `return {
             intent: "continue",
             state: { plan: ["one", "two"] },
             context: [
               { role: "user", text: "the original goal" },
               { role: "assistant", text: "I chose to keep only this." }
             ]
           }`
        ),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    const second = model.recorder.requests[1]
    expect(second?.messages).toEqual([
      ModelRequest.Message.user("the original goal"),
      ModelRequest.Message.assistant("I chose to keep only this.", { stopReason: "stop" })
    ])
    expect(second?.system.at(-1)?.text).toBe(
      "Agent-owned durable state for this frame (JSON), also available in the cell as ctx.state:\n{\"plan\":[\"one\",\"two\"]}"
    )
    // The transition is on the record, so a replayed run rebuilds the same
    // state and the same context.
    const applied = of(events, "transition-applied")[0]
    expect(applied?.transition).toMatchObject({ _tag: "continue", state: { plan: ["one", "two"] } })
    const encoded = Schema.encodeUnknownSync(CellTurn.State)(
      CellTurn.make({
        session: "s",
        seat: "a:b",
        modelParams: ModelRequest.GenerationParams.make(),
        layers: [],
        capabilityEnvelope: [],
        placement: Option.none(),
        contextWindow: window,
        agentState: { plan: ["one", "two"] }
      })
    )
    expect(Schema.decodeUnknownSync(CellTurn.State)(encoded).agentState).toEqual({ plan: ["one", "two"] })
  })

  it("turns a malformed cell into an observation the next frame can correct", async () => {
    const { engine, events, model } = await run({
      script: [
        prose("I will just describe the plan instead of writing a cell."),
        emits(`return "not a transition"`),
        emits(`throw new RangeError("off by one")`),
        emits(`return { intent: "complete", output: "recovered" }`)
      ]
    })

    const settled = of(events, "cell-settled")
    expect(settled.map((event) => event.outcome._tag)).toEqual(["rejected", "rejected", "raised", "settled"])
    expect((settled[0]?.outcome as Cell.Rejected).code).toBe("no_cell")
    expect((settled[1]?.outcome as Cell.Rejected).code).toBe("invalid_transition")
    expect((settled[2]?.outcome as Cell.Raised).name).toBe("RangeError")
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      ModelRequest.TextPart.make({ text: "recovered" })
    ])
    expect(engine.recorder.calls).toHaveLength(0)

    // Each failure is on the transcript the next frame sees.
    const observations = model.recorder.requests[3]?.messages.filter((message) => message.role === "user") ?? []
    expect(observations.some((message) => message.content[0]?.text.includes("fenced ```cell block"))).toBe(true)
    expect(observations.some((message) => message.content[0]?.text.includes("RangeError"))).toBe(true)
  })

  it("refuses a flow outside the catalog or outside the capability envelope, catchably", async () => {
    const { engine, events } = await run({
      script: [
        emits(
          `const notes = []
           try { await ctx.call("net/fetch", {}) } catch (error) { notes.push(error.message) }
           try { await ctx.call("shell/run", {}) } catch (error) { notes.push(error.message) }
           return { intent: "complete", output: notes.join(" | ") }`
        )
      ],
      flows: [
        descriptor("fs/list", { capabilities: ["fs:read:**"] }),
        descriptor("shell/run", { capabilities: ["proc:spawn:**"], tier: "irreversible" })
      ]
    })

    const output = of(events, "resolved")[0]?.message.content[0]
    expect(output?.type === "text" ? output.text : "").toBe(
      "Unknown flow net/fetch. Only the flows in ctx.flows are callable."
        + " | Flow shell/run needs proc:spawn:**, which is outside this run's capability envelope."
    )
    // Neither refusal reached the engine.
    expect(engine.recorder.calls).toHaveLength(0)
  })

  it("refuses a malformed declared capability instead of treating it as authority-free", async () => {
    const { engine, events } = await run({
      script: [
        emits(
          `try { await ctx.call("broken", {}) } catch (error) {
             return { intent: "complete", output: error.message }
           }`
        )
      ],
      flows: [descriptor("broken", { capabilities: ["not-a-capability"] })]
    })

    expect(engine.recorder.calls).toHaveLength(0)
    const output = of(events, "resolved")[0]?.message.content[0]
    expect(output?.type === "text" ? output.text : "").toContain("outside this run's capability envelope")
  })

  it("parks durably when a call needs a permission the run does not hold", async () => {
    const request = new Permission.PermissionRequired({
      requestId: "perm-1",
      capability: Capability.make("proc:spawn", "**"),
      tier: "irreversible",
      meta: {}
    })
    const { engine, events } = await run({
      script: [
        emits(
          `await ctx.call("fs/list", { path: "." })
           await ctx.call("shell/run", { command: "ls" })
           return { intent: "complete", output: "unreachable" }`
        )
      ],
      flows: [
        descriptor("fs/list", { capabilities: ["fs:read:**"] }),
        descriptor("shell/run", { tier: "irreversible" })
      ],
      calls: [
        { _tag: "Success", value: [] },
        { _tag: "PermissionRequired", request }
      ]
    })

    expect(of(events, "permission-required")[0]?.request.requestId).toBe("perm-1")
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("suspended")
    expect(of(events, "suspended")[0]?.reason.code).toBe("permission-required")
    expect(engine.recorder.suspend.map((reason) => reason.code)).toEqual(["permission-required"])
    // The first call settled before the park, so a resume replays it.
    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["fs/list", "shell/run"])
  })

  it("parks when the cell asks to, carrying the reason it chose", async () => {
    const { engine, events } = await run({
      script: [
        emits(
          `return { intent: "park", state: { waiting: true }, reason: "waiting-input", message: "which branch?" }`
        )
      ]
    })

    expect(of(events, "transition-applied")[0]?.transition).toMatchObject({ _tag: "park" })
    expect(of(events, "suspended")[0]?.reason).toMatchObject({
      code: "waiting-input",
      message: "which branch?"
    })
    expect(engine.recorder.suspend).toEqual([
      expect.objectContaining({ code: "waiting-input", message: "which branch?" })
    ])
  })

  it("stops at the frame budget instead of continuing forever", async () => {
    const { events, model } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`),
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "again" }] }`)
      ],
      state: state({ maxFrames: 2 })
    })

    expect(model.recorder.requests).toHaveLength(2)
    const resolved = of(events, "resolved")[0]?.message.content[0]
    expect(resolved?.type === "text" ? resolved.text : "").toContain("frame budget of 2 is exhausted")
  })

  it("runs the same loop on the browser-capable QuickJS binding", async () => {
    // The binding a browser host provides is the one proved here: same
    // controller, same events, a genuinely separate realm underneath.
    const model = ScriptedModel.make([
      emits(
        `const listed = await ctx.call("fs/list", { path: "." })
         return { intent: "complete", output: listed.join(",") }`
      )
    ])
    const engine = ScriptedEngine.make(model.model, [], [{ _tag: "Success", value: ["alpha", "beta"] }])
    const events: Array<AgentEvent.AgentEvent> = []
    await CellTurn.run({
      state: state(),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] })]
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(engine.layer),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(Steering.layerNoop()),
      Effect.runPromise
    )

    expect(of(events, "cell-call-settled")).toHaveLength(1)
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      ModelRequest.TextPart.make({ text: "alpha,beta" })
    ])
  })

  it("declares no provider tools and forbids the provider from inventing one", async () => {
    const { model } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)]
    })

    expect(model.recorder.requests[0]?.tools).toEqual([])
    expect(model.recorder.requests[0]?.toolChoice).toBe("none")
  })

  it("teaches one cell contract and the callable flows, and keeps teaching it across frames", async () => {
    const flows = [
      descriptor("fs/list", { capabilities: ["fs:read:**"] }),
      descriptor("shell/run", { tier: "irreversible" })
    ]
    const taught = state()
    const { model } = await run({
      script: [
        emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "next" }] }`),
        emits(`return { intent: "complete", output: "done" }`)
      ],
      flows,
      state: CellTurn.make({
        session: "session-1",
        seat: taught.seat,
        modelParams: taught.modelParams,
        layers: taught.layers,
        capabilityEnvelope: taught.capabilityEnvelope,
        placement: taught.placement,
        contextWindow: CellTurn.teach(taught.contextWindow, flows),
        maxFrames: 4
      })
    })

    const system = (index: number) => model.recorder.requests[index]?.system.map((part) => part.text).join("\n") ?? ""
    expect(system(0)).toContain("```cell")
    expect(system(0)).toContain("ctx.call")
    expect(system(0)).toContain("- fs/list (sealed) capabilities=fs:read:**: The fs/list flow.")
    expect(system(0)).toContain("- shell/run (irreversible): The shell/run flow.")
    // Teaching is a prefix segment, so the cell's own projected context replaces
    // the transcript without ever dropping the contract.
    expect(system(1)).toBe(system(0))
  })

  it("appends steering after the cell's own context and applies seat changes to the next frame", async () => {
    const model = ScriptedModel.make([
      emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "kept" }] }`),
      emits(`return { intent: "complete", output: "done" }`)
    ])
    const engine = ScriptedEngine.make(model.model, [], [])
    let drained = false
    const steering = Steering.layer({
      read: () => Effect.succeed(Steering.empty()),
      drain: () =>
        Effect.sync(() => {
          if (drained) {
            return {
              inserts: [],
              seatChanges: [],
              activatedToolNames: [],
              remaining: Steering.empty(),
              queued: false
            }
          }
          drained = true
          return {
            inserts: [ModelRequest.Message.user("steer: prefer the shorter route")],
            seatChanges: [
              { _tag: "SeatChange", delivery: "steer", admittedAt: 1, seat: "openai:other-model" },
              { _tag: "ThinkingChange", delivery: "steer", admittedAt: 2, thinking: "high" }
            ],
            activatedToolNames: [],
            remaining: Steering.empty(),
            queued: false
          }
        })
    })
    const events: Array<AgentEvent.AgentEvent> = []
    await CellTurn.run({ state: state(), flows: [] }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(engine.layer),
      Effect.provide(Sandbox.layerRestricted),
      Effect.provide(steering),
      Effect.runPromise
    )

    expect(of(events, "steering-drained")[0]?.messages).toEqual([
      ModelRequest.Message.user("steer: prefer the shorter route")
    ])
    const second = model.recorder.requests[1]
    expect(second?.messages).toEqual([
      ModelRequest.Message.user("kept"),
      ModelRequest.Message.user("steer: prefer the shorter route")
    ])
    // The seat change applies only after the turn closes.
    expect(model.recorder.requests[0]?.modelId).toBe("test-model")
    expect(second?.modelId).toBe("other-model")
    expect(second?.params.reasoningEffort).toBe("high")
  })

  it("journals the turn-boundary drain through the engine instead of reading the queue directly", async () => {
    const model = ScriptedModel.make([
      emits(`return { intent: "continue", state: null, context: [{ role: "user", text: "kept" }] }`),
      emits(`return { intent: "complete", output: "done" }`)
    ])
    const engine = ScriptedEngine.make(model.model, [], [])
    await CellTurn.run({ state: state(), flows: [] }).pipe(
      Stream.runDrain,
      Effect.provide(engine.layer),
      Effect.provide(Sandbox.layerRestricted),
      Effect.provide(Steering.layerNoop()),
      Effect.runPromise
    )

    // The drain is a nondeterministic read, so it must reach the steering
    // source through a journaled engine boundary — keyed on the frame and the
    // cell digest — never through a bare `steering.drain` a replay would
    // re-issue against an already-drained queue.
    expect(engine.recorder.records.map((boundary) => boundary.name)).toEqual(["steering-drain"])
    expect(engine.recorder.records[0]?.identity).toMatchObject({ session: "session-1", frame: 0 })
    expect(engine.recorder.records[0]?.identity.boundary).toMatch(/^[a-f0-9]{64}$/)
  })

  it("reports a model step that never settles as a typed harness failure", async () => {
    const { events, failure } = await run({
      script: [{ events: [ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "partial" })] }]
    })

    expect(failure).toMatchObject({ code: "model_failed" })
    expect(of(events, "turn-opened")).toHaveLength(1)
  })

  it("stops at the budget even when the last frame produced no usable cell", async () => {
    const { events } = await run({
      script: [prose("no cell here either")],
      state: state({ maxFrames: 1 })
    })

    expect(of(events, "cell-settled")[0]?.outcome._tag).toBe("rejected")
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("resolved")
    const resolved = of(events, "resolved")[0]?.message.content[0]
    expect(resolved?.type === "text" ? resolved.text : "").toContain("frame budget of 1 is exhausted")
  })

  it("reports one abort when the run is interrupted", async () => {
    const model = ScriptedModel.make([
      emits(
        `await ctx.call("fs/list", { path: "." })
         return { intent: "complete", output: "unreachable" }`
      )
    ])
    const engine = ScriptedEngine.make(model.model, [], [{ _tag: "Interrupt" }])
    const events: Array<AgentEvent.AgentEvent> = []
    const outcome = await CellTurn.run({
      state: state(),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] })]
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(engine.layer),
      Effect.provide(Sandbox.layerRestricted),
      Effect.provide(Steering.layerNoop()),
      Effect.exit,
      Effect.runPromise
    )

    // Interruption is forwarded, not laundered into a clean finish.
    expect(outcome._tag).toBe("Failure")
    expect(of(events, "aborted")).toHaveLength(1)
    expect(of(events, "turn-closed").at(-1)?.outcome).toBe("aborted")
  })
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

describe("CellTurn compaction", () => {
  it("compacts through a sealed step, records the settlement, and asks the model on the compacted window", async () => {
    const crowdedState = CellTurn.make({
      session: "session-1",
      seat: "anthropic:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: [],
      placement: Option.none(),
      contextWindow: crowded,
      contextWindowTokens: 40_000,
      maxFrames: 2
    })
    const { engine, events, model } = await run({
      script: [prose("the compacted summary"), emits(`return { intent: "complete", output: "done" }`)],
      state: crowdedState,
      flows: []
    })

    const prefixLength = Compaction.selectPrefix(crowded)
    expect(prefixLength).toBeGreaterThan(0)

    // The summary was produced by its own sealed step, not by a request the
    // controller quietly rewrote on its way out.
    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(model.recorder.requests[0]?.system.map((part) => part.text)).toContain(
      Compaction.summaryInstruction
    )

    // The settlement is on the record, keyed to exactly the prefix it replaced.
    const settled = of(events, "compaction-settled")
    expect(settled).toHaveLength(1)
    expect(settled[0]?.replacedPrefixDigest).toBe(
      Result.getOrThrow(ContextWindow.prefixDigest(crowded, prefixLength))
    )
    const summary = settled[0]?.summary
    expect(summary?.role).toBe("assistant")

    // Replay rebuilds the exact next model context: applying the recorded
    // settlement to the original window reproduces what the second sealed step
    // was actually asked.
    const step = Effect.runSync(
      Compaction.declare(crowded, prefixLength, {
        identity: "flows/harness/CellTurn.compaction",
        modelId: "test-model",
        params: ModelRequest.GenerationParams.make()
      })
    )
    const rebuilt = Effect.runSync(Compaction.apply(crowded, step, summary!))
    expect(model.recorder.requests[1]?.messages).toEqual(ContextWindow.render(rebuilt).messages)
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      ModelRequest.TextPart.make({ text: "done" })
    ])
  })

  it("leaves the window alone when the host declared no context budget", async () => {
    const { engine, events } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)],
      state: CellTurn.make({
        session: "session-1",
        seat: "anthropic:test-model",
        modelParams: ModelRequest.GenerationParams.make(),
        layers: ["layer-a"],
        capabilityEnvelope: [],
        placement: Option.none(),
        contextWindow: crowded,
        maxFrames: 2
      }),
      flows: []
    })

    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(of(events, "compaction-settled")).toHaveLength(0)
    expect(of(events, "resolved")).toHaveLength(1)
  })
})
