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
import { Clock, Effect, Option, Result, Schema, Stream } from "effect"
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
    /** Declared write set, which is what makes a call count as a mutation. */
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

const state = (
  overrides: {
    readonly maxFrames?: number
    readonly envelope?: ReadonlyArray<string>
    readonly readOnlyCap?: number
    /** Declared per case: a park is only honored where somebody can answer it. */
    readonly approvalChannel?: boolean
    /** Wall-clock one model call may spend; omitted takes the armed default. */
    readonly modelCallMs?: number
  } = {}
) =>
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
    maxFrames: overrides.maxFrames ?? 4,
    readOnlyCap: overrides.readOnlyCap ?? 0,
    approvalChannel: overrides.approvalChannel ?? false,
    ...(overrides.modelCallMs === undefined ? {} : { modelCallMs: overrides.modelCallMs })
  })

/**
 * A clock that advances a fixed step every time it is read.
 *
 * Durations are measured through the injected clock, so a test declares the
 * elapsed time instead of racing the host's wall clock.
 */
const tickingClock = (stepMillis: number): Clock.Clock => {
  let now = 0
  const read = (): number => {
    const current = now
    now += stepMillis
    return current
  }
  return {
    currentTimeMillisUnsafe: read,
    currentTimeMillis: Effect.sync(read),
    currentTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
    sleep: () => Effect.void
  }
}

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
  readonly clock?: Clock.Clock
  /**
   * The workspace the engine can measure, as one string. Omitted means the
   * host measures nothing, which is what every case written before observed
   * mutation existed expects.
   */
  readonly tree?: string
  /**
   * Whether the engine's walk covered the whole tree. False is the bounded
   * measurement a checkout larger than the host's path bound produces.
   */
  readonly treeComplete?: boolean
}): Promise<Run> => {
  const model = ScriptedModel.make(options.script)
  const engine = ScriptedEngine.make(model.model, [], options.calls ?? [], options.tree, options.treeComplete)
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
    (effect) => options.clock === undefined ? effect : Effect.provideService(effect, Clock.Clock, options.clock),
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
  it("projects a model-boundary retry as its own control event", async () => {
    const settled = emits(`return { intent: "complete", state: {}, output: "done" }`)
    const { events } = await run({
      script: [{
        events: [
          ModelEvent.ModelEvent.Retry({
            type: "retry",
            attempt: 1,
            code: "transport",
            delayMillis: 1_137
          }),
          ...settled.events
        ]
      }]
    })

    // The delay travels with the attempt. Every retry of one sealed step is
    // journaled when that step settles, so the event timestamps are identical
    // whether the backoff waited or not, and the schedule is only legible if
    // the event carries it.
    expect(of(events, "model-retried")).toEqual([
      expect.objectContaining({ attempt: 1, code: "transport", delayMillis: 1_137 })
    ])
  })

  it("records the armed discipline once before a run's first frame", async () => {
    const { events } = await run({
      state: state({ maxFrames: 2, readOnlyCap: 3 }),
      script: [
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "continue", state: {}, context: [] }`)
      ]
    })

    const armed = of(events, "discipline-armed")
    expect(armed).toEqual([
      expect.objectContaining({
        readOnlyCap: 3,
        maxFrames: 2,
        callMs: Sandbox.defaultLimits.callMs,
        // The budget the loop's own step runs under, journaled beside the
        // budgets its cells run under. `model-settled` already states each
        // call's `durationMillis`, so the pair is what makes the ceiling
        // gradeable from the journal alone.
        modelCallMs: CellTurn.defaultModelCallMs,
        // The convergence threshold, armed for every run that does not opt
        // out. A wave that journals no repeat demand can then tell "armed and
        // never needed" from "never armed".
        repeatCap: CellTurn.defaultRepeatFrames
      })
    ])
    expect(armed[0]).not.toHaveProperty("totalMs")
    expect(events[0]?._tag).toBe("discipline-armed")
  })

  it("hands the armed model-call budget to every sealed step it opens", async () => {
    const { engine, events } = await run({
      state: state({ modelCallMs: 45_000, maxFrames: 3 }),
      script: [
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ]
    })

    // Enforcement is the engine's, so the controller has to say the number on
    // the step rather than leave the engine to be configured with its own
    // copy. One value, from one place, or the journal's record of what the run
    // armed is not evidence of what the run enforced.
    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(engine.recorder.sealStep.map((step) => step.modelCallMs)).toEqual([45_000, 45_000])
    expect(of(events, "discipline-armed")[0]?.modelCallMs).toBe(45_000)
  })

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
      state: state({ approvalChannel: true }),
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
    const { events, model } = await run({
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
    const drains = engine.recorder.records.filter((boundary) => boundary.name === "steering-drain")
    expect(drains).toHaveLength(1)
    expect(drains[0]?.identity).toMatchObject({ session: "session-1", frame: 0 })
    expect(drains[0]?.identity.boundary).toMatch(/^[a-f0-9]{64}$/)
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

/** A command flow whose result a frame reads, plus the run that may call it. */
const check = descriptor("bash", { capabilities: ["proc:spawn:*"], tier: "irreversible" })

/** A flow whose declared write set is what makes it count as a mutation. */
const editor = descriptor("edit", { capabilities: ["fs:write:**"], tier: "compensable", writes: ["/**"] })

const capped = (cap: number, maxFrames: number) =>
  state({ readOnlyCap: cap, maxFrames, envelope: ["fs:read:**", "fs:write:**", "proc:spawn:*"] })

const readCells = (count: number): ReadonlyArray<ScriptedModel.Step> =>
  Array.from(
    { length: count },
    () =>
      emits(
        `await ctx.call("fs/list", { path: "." })
         return { intent: "continue", state: {}, context: [{ role: "user", text: "still reading" }] }`
      )
  )

const successes = (count: number): ReadonlyArray<ScriptedEngine.CallStep> =>
  Array.from({ length: count }, () => ({ _tag: "Success", value: ["alpha.md"] }) as const)

describe("CellTurn invalid probes", () => {
  const brokenCheck = {
    _tag: "Success",
    value: {
      exitCode: 1,
      stdout: "",
      invalidProbe: {
        reason: "unknown-test",
        evidence: "AttributeError: type object 'Basic' has no attribute 'test_absent'",
        message: "This command never ran a check: the test runner could not find the test that was named."
      }
    }
  } as const

  const probing = (summary: string) =>
    emits(
      `await ctx.call("bash", { command: "pytest -q tests/test_admin.py::Basic::test_absent" })
       return { intent: "continue", state: {}, context: [{ role: "user", text: ${JSON.stringify(summary)} }] }`
    )

  it("contradicts a cell that read a broken probe as the bug reproducing", async () => {
    // The cell chooses the context its successor sees, so a wrong reading
    // travels forward unopposed unless the controller states the fact itself.
    const { model } = await run({
      state: state({ maxFrames: 3, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        probing("The test still fails, so the bug is unfixed."),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: [brokenCheck]
    })

    const next = JSON.stringify(model.recorder.requests[1]?.messages)
    expect(next).toContain("The test still fails, so the bug is unfixed.")
    expect(next).toContain("Invalid probe")
    expect(next).toContain("unknown-test")
    expect(next).toContain("reads identically on a broken tree and on a fixed one")
  })

  it("counts every broken probe in the frame, not just the first", async () => {
    const { model } = await run({
      state: state({ maxFrames: 3, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        emits(
          `await ctx.call("bash", { command: "pytest -q tests/a.py::Basic::test_absent" })
           await ctx.call("bash", { command: "pytest -q tests/b.py::Basic::test_absent" })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "both fail" }] }`
        ),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: [brokenCheck, brokenCheck]
    })

    expect(JSON.stringify(model.recorder.requests[1]?.messages)).toContain("Invalid probe — 2 calls")
  })

  it("ignores a declaration that is not the shape the contract states", async () => {
    // The key is a wire contract with whatever flow the host bound, so a
    // result that carries something else under it is read as an ordinary
    // result rather than trusted or refused.
    const { model } = await run({
      state: state({ maxFrames: 3, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        probing("ran the check"),
        emits(
          `await ctx.call("bash", { command: "pytest -q tests/test_admin.py::Basic::test_absent" })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "again" }] }`
        ),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: [
        { _tag: "Success", value: { exitCode: 1, invalidProbe: "unknown-test" } },
        { _tag: "Success", value: { exitCode: 1, invalidProbe: { reason: "unknown-test", message: 7 } } }
      ]
    })

    expect(JSON.stringify(model.recorder.requests[1]?.messages)).not.toContain("Invalid probe")
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).not.toContain("Invalid probe")
  })

  it("says nothing when the frame's failing check actually ran", async () => {
    const { model } = await run({
      state: state({ maxFrames: 3, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        probing("One test failed, as expected."),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: [{ _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } }]
    })

    expect(JSON.stringify(model.recorder.requests[1]?.messages)).not.toContain("Invalid probe")
  })

  it("carries the notice out through a frame that threw before returning a transition", async () => {
    const { model } = await run({
      state: state({ maxFrames: 3, envelope: ["proc:spawn:*"] }),
      flows: [check],
      script: [
        emits(
          `await ctx.call("bash", { command: "pytest -q tests/test_admin.py::Basic::test_absent" })
           throw new Error("half-written cell")`
        ),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: [brokenCheck]
    })

    const next = JSON.stringify(model.recorder.requests[1]?.messages)
    expect(next).toContain("half-written cell")
    expect(next).toContain("Invalid probe")
  })
})

describe("CellTurn read-only cap", () => {
  it("demands a write or a justification once the cap is reached", async () => {
    const { events, model } = await run({
      state: capped(2, 5),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: readCells(5),
      calls: successes(5)
    })

    // Frames one and two read; the third frame is the one that carries the
    // demand, and it names both ways out of it.
    expect(JSON.stringify(model.recorder.requests[1]?.messages)).not.toContain("Read-only discipline")
    const demanded = JSON.stringify(model.recorder.requests[2]?.messages)
    expect(demanded).toContain("Read-only discipline")
    expect(demanded).toContain("justification")
    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 2,
      cap: 2,
      nextFrame: 2,
      nextAction: "read-only"
    })
  })

  it("records a demanded frame that writes before continuing", async () => {
    const { events } = await run({
      state: capped(1, 3),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(1),
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           return { intent: "continue", state: {}, context: [] }`
        ),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: successes(2)
    })

    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 1,
      cap: 1,
      nextFrame: 1,
      nextAction: "write"
    })
  })

  it("records a demanded frame that wrote something and then raised", async () => {
    const { events } = await run({
      state: capped(1, 3),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(1),
        emits(
          `await ctx.call("edit", { path: "a.py", text: "partial" })
           throw new Error("post-edit diagnostic failed")`
        ),
        emits(
          `await ctx.call("edit", { path: "a.py", text: "recovered" })
           return { intent: "complete", state: {}, output: "done" }`
        )
      ],
      calls: successes(3)
    })

    // The edit landed before the throw, so the demanded frame answered the
    // demand even though it settled no transition.
    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 1,
      cap: 1,
      nextFrame: 1,
      nextAction: "write"
    })
  })

  it("leaves a demand pending across a frame that raised without writing", async () => {
    const { events } = await run({
      state: capped(2, 5),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(2),
        emits(`throw new Error("diagnostic failed")`),
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           return { intent: "complete", state: {}, output: "done" }`
        )
      ],
      calls: successes(3)
    })

    // A demand is answered by a write or by a justification, and a frame that
    // settled no transition produced neither. Recording the raise as the
    // answer closed the demand with nothing behind it and let the next frame
    // start clean; the demand instead waits for frame 3, which writes.
    expect(of(events, "read-only-demanded")).toEqual([
      expect.objectContaining({ streak: 2, cap: 2, nextFrame: 3, nextAction: "write" })
    ])
  })

  it("counts a frame that raised without writing toward the streak", async () => {
    const { events, model } = await run({
      state: capped(3, 4),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(1),
        emits(`throw new Error("diagnostic failed")`),
        ...readCells(1),
        ...readCells(1)
      ],
      calls: successes(3)
    })

    // Freezing the counter on a raise made a run that alternates raising with
    // reading take two frames to advance the streak by one, so a cap of twelve
    // needed twenty-four frames and a run that raised more often never reached
    // it. The raising frame wrote nothing, so it counts: the streak is at the
    // cap of three by frame 2 and frame 3 carries the demand, where before the
    // demand arrived a frame after the budget ran out.
    expect(JSON.stringify(model.recorder.requests[3]?.messages)).toContain("Read-only discipline")
    expect(of(events, "read-only-demanded")).toEqual([
      expect.objectContaining({ streak: 3, cap: 3, nextFrame: 3, nextAction: "read-only" })
    ])
  })

  it("stops a run whose raising frames spend twice the cap", async () => {
    const { failure, model } = await run({
      state: capped(1, 6),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        emits(`throw new Error("first")`),
        emits(`throw new Error("second")`),
        emits(`return { intent: "complete", state: {}, output: "never reached" }`)
      ]
    })

    // A raise continues the run, so it is judged like every other continuing
    // frame: two frames that changed nothing is twice a cap of one, and the
    // run stops there rather than raising its way to the budget wall.
    expect(failure).toMatchObject({ code: "read_only_cap" })
    expect(model.recorder.requests).toHaveLength(2)
  })

  it("counts a frame that answered with no cell at all toward the streak", async () => {
    const { events, model } = await run({
      state: capped(3, 4),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(1),
        prose("I will describe the plan instead of emitting a cell."),
        ...readCells(1),
        ...readCells(1)
      ],
      calls: successes(3)
    })

    // A rejected cell is the same stall as a raise seen one step earlier: no
    // cell ran, so the frame called nothing and wrote nothing. Freezing the
    // counter here left a model that answers with prose free to spend the
    // whole frame budget without the cap ever advancing.
    expect(of(events, "cell-settled")[1]?.outcome._tag).toBe("rejected")
    expect(JSON.stringify(model.recorder.requests[3]?.messages)).toContain("Read-only discipline")
    expect(of(events, "read-only-demanded")).toEqual([
      expect.objectContaining({ streak: 3, cap: 3, nextFrame: 3, nextAction: "read-only" })
    ])
  })

  it("stops a run that never emits a cell at twice the cap", async () => {
    const { failure, model } = await run({
      state: capped(1, 6),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        prose("first, some reasoning"),
        prose("second, more reasoning"),
        emits(`return { intent: "complete", state: {}, output: "never reached" }`)
      ]
    })

    // Twice the cap ends this exit too. Without it a run whose model cannot
    // produce a parseable cell spends every frame it has and then reports
    // whatever the budget message says, which is the failure the cap exists to
    // refuse.
    expect(failure).toMatchObject({ code: "read_only_cap" })
    expect(model.recorder.requests).toHaveLength(2)
  })

  it("clears the streak when a call declares a write", async () => {
    const { model } = await run({
      state: capped(2, 5),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(1),
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "edited" }] }`
        ),
        ...readCells(3)
      ],
      calls: successes(5)
    })

    // The edit reset the counter, so the frame that would have been demanded
    // is not, and the next demand only arrives two read-only frames later.
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).not.toContain("Read-only discipline")
    expect(JSON.stringify(model.recorder.requests[3]?.messages)).not.toContain("Read-only discipline")
    expect(JSON.stringify(model.recorder.requests[4]?.messages)).toContain("Read-only discipline")
  })

  it("counts a call that declares its own writes, whatever the flow's registry envelope says", async () => {
    const shell = descriptor("bash", { capabilities: ["proc:spawn:*"], tier: "irreversible" })
    const { model } = await run({
      state: capped(1, 4),
      flows: [shell],
      script: [
        emits(
          `await ctx.call("bash", { command: "sed -i s/a/b/ a.py", writes: ["a.py"] })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "patched" }] }`
        ),
        emits(
          `await ctx.call("bash", { command: "pytest", writes: [] })
           return { intent: "continue", state: {}, context: [{ role: "user", text: "ran tests" }] }`
        ),
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "continue", state: {}, context: [] }`)
      ],
      calls: [
        { _tag: "Success", value: { exitCode: 0 } },
        { _tag: "Success", value: { exitCode: 0 } }
      ]
    })

    // The registry-time envelope of a shell flow is the conservative empty
    // set, so classification reads what the invocation declared: the frame
    // that wrote a file cleared the streak, and the frame that only ran tests
    // did not.
    expect(JSON.stringify(model.recorder.requests[1]?.messages)).not.toContain("Read-only discipline")
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
  })

  it("lets a justification buy quiet frames without stopping the run's clock", async () => {
    const { failure, model } = await run({
      state: capped(2, 12),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] })],
      script: [
        ...readCells(2),
        emits(
          `return {
             intent: "continue",
             state: {},
             context: [{ role: "user", text: "still reading" }],
             justification: "the failing test names a symbol I have not located yet"
           }`
        ),
        ...readCells(9)
      ],
      calls: successes(12)
    })

    // The justified frame silences the demand for the next two frames, and
    // the counter keeps running underneath it: the run still stops at twice
    // the cap rather than reading forever on a rationale.
    expect(JSON.stringify(model.recorder.requests[3]?.messages)).not.toContain("Read-only discipline")
    expect(failure).toMatchObject({ code: "read_only_cap" })
  })

  it("stops the run at twice the cap instead of letting it read to the budget wall", async () => {
    const { failure, model } = await run({
      state: capped(1, 20),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] })],
      script: readCells(20),
      calls: successes(20)
    })

    expect(model.recorder.requests).toHaveLength(2)
    expect(failure).toMatchObject({ code: "read_only_cap" })
  })

  it("refuses to let a run that never wrote anything complete past the hard cap", async () => {
    const { events, failure } = await run({
      state: capped(1, 20),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] })],
      script: [
        ...readCells(1),
        emits(`return { intent: "complete", state: {}, output: "implemented the fix" }`)
      ],
      calls: successes(2)
    })

    expect(failure).toMatchObject({ code: "read_only_cap" })
    expect(of(events, "resolved")).toHaveLength(0)
  })

  it("clears the streak from a frame that wrote something and then threw", async () => {
    const { model } = await run({
      state: capped(1, 4),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           throw new Error("lost the thread after editing")`
        ),
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "continue", state: {}, context: [] }`)
      ],
      calls: successes(1)
    })

    // The edit landed before the throw, so the frame is not read-only even
    // though it settled no transition, and the next frame is not demanded.
    expect(JSON.stringify(model.recorder.requests[1]?.messages)).not.toContain("Read-only discipline")
  })

  it("journals the demand a thirteen-frame stall must produce at the shipped cap", async () => {
    // The exact shape SWE-bench wave 5's pytest run had: one frame that edits,
    // then thirteen that only read, under the `readOnlyCap: 12` its own
    // `discipline-armed` record names. That run journaled no demand at all,
    // and spent frames four through sixteen reading, diagnosing, and finally
    // destroying the edit it had made, with no controller pressure at any
    // point. The cap is only worth arming if the twelfth quiet frame is heard.
    const { events, model } = await run({
      state: capped(CellTurn.defaultReadOnlyFrames, 16),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           return { intent: "continue", state: {}, context: [] }`
        ),
        ...readCells(13),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: successes(14)
    })

    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: CellTurn.defaultReadOnlyFrames,
      cap: CellTurn.defaultReadOnlyFrames,
      nextFrame: 13,
      nextAction: "read-only"
    })
    expect(JSON.stringify(model.recorder.requests[13]?.messages)).toContain("Read-only discipline")
  })

  it("asks a demanded frame for evidence, not for a keystroke", async () => {
    const { model } = await run({
      state: capped(1, 3),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [...readCells(2), emits(`return { intent: "complete", state: {}, output: "done" }`)],
      calls: successes(2)
    })

    // Wave 4 answered the first version of this text by running
    // `git show <base>:<path> > <path>`, which wrote something and deleted the
    // fix the run had already landed. The two ways out are stated as equals,
    // and the writes that are worse than another quiet frame are named.
    const demanded = JSON.stringify(model.recorder.requests[1]?.messages)
    expect(demanded).toContain("equally acceptable")
    expect(demanded).toContain("name the evidence for")
    expect(demanded).toContain("Do not write something merely to answer this notice")
    expect(demanded).toContain("A restore, a revert, an overwrite from captured output")
  })

  it("does not let a write the boundary refused clear the read-only streak", async () => {
    const { events, model } = await run({
      // `edit` needs `fs:write:**`, which this run's envelope does not carry,
      // so the boundary refuses the call before it reaches the engine.
      state: state({ readOnlyCap: 2, maxFrames: 5, envelope: ["fs:read:**"] }),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        ...readCells(1),
        emits(
          `try { await ctx.call("edit", { path: "a.py", text: "fixed" }) } catch (error) {}
           return { intent: "continue", state: {}, context: [] }`
        ),
        ...readCells(1),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: successes(2)
    })

    // A refused call performed nothing, so the frame that made it is still a
    // read-only frame and the streak runs through it. Counting it as a write
    // is how a stalled run buys silence from the cap with a call that never
    // happened.
    expect(of(events, "cell-call-started").map((event) => event.call.flowName)).toEqual(["fs/list", "fs/list"])
    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 2,
      cap: 2,
      nextFrame: 2,
      nextAction: "read-only"
    })
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
  })

  it("leaves a run with no cap alone", async () => {
    const { failure, model } = await run({
      state: state({ maxFrames: 4 }),
      script: readCells(4),
      calls: successes(4)
    })

    // Nothing armed the cap, so reading is only bounded by the frame budget.
    expect(model.recorder.requests).toHaveLength(4)
    expect(JSON.stringify(model.recorder.requests)).not.toContain("Read-only discipline")
    expect(failure).toBeUndefined()
  })
})

describe("CellTurn observed mutation", () => {
  /**
   * The one shell command that started this: on SWE-bench wave 5 the pytest
   * run overwrote a tracked source file with a redirect, deleting the fix it
   * had landed six frames earlier. The invocation names `mode`, `command`,
   * `cwd` and nothing else — no write set anywhere — so every control that
   * reads declarations saw a frame that did nothing.
   */
  const redirect = `await ctx.call("bash", {
      mode: "unhermetic",
      command: "git show base:src/_pytest/python.py > src/_pytest/python.py"
    })
    return { intent: "continue", state: {}, context: [] }`

  const reading = `await ctx.call("bash", { mode: "unhermetic", command: "git status --short" })
    return { intent: "continue", state: {}, context: [] }`

  const shell = (
    cells: ReadonlyArray<string>,
    calls: ReadonlyArray<ScriptedEngine.CallStep>,
    overrides: {
      readonly cap?: number
      readonly tree?: string
      readonly treeComplete?: boolean
      readonly maxFrames?: number
    } = {}
  ) =>
    run({
      state: state({
        readOnlyCap: overrides.cap ?? 2,
        maxFrames: overrides.maxFrames ?? cells.length + 1,
        envelope: ["fs:read:**", "fs:write:**", "proc:spawn:*"]
      }),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), check, editor],
      script: cells.map(emits),
      calls,
      tree: overrides.tree ?? "src/_pytest/python.py=fixed",
      ...(overrides.treeComplete === undefined ? {} : { treeComplete: overrides.treeComplete })
    })

  it("counts a shell redirect as a mutation and resets the read-only streak", async () => {
    const { events, model } = await shell(
      [reading, reading, redirect, reading, reading, reading],
      [
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        // The call declares nothing and changes the tree anyway.
        { _tag: "Success", value: { exitCode: 0, stdout: "" }, tree: "src/_pytest/python.py=base" },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } }
      ],
      { maxFrames: 6 }
    )

    const observed = of(events, "mutation-observed")
    expect(observed.map((event) => event.mutated)).toEqual([false, false, true, false, false, false])
    // The frame that rewrote the file declared no write at all. That gap is
    // the defect, so both numbers are journaled.
    expect(observed[2]).toMatchObject({
      basis: "observed",
      mutated: true,
      declaredWrites: 0,
      digest: "src/_pytest/python.py=base"
    })

    // Frames 0 and 1 build the streak to the cap, so frame 2 is demanded — and
    // the redirect answers it as a write, which is exactly what the old
    // declaration-only accounting could not see. The streak then restarts and
    // reaches the cap again at frame 4, demanding frame 5.
    expect(of(events, "read-only-demanded")).toEqual([
      expect.objectContaining({ nextFrame: 2, nextAction: "write" }),
      expect.objectContaining({ nextFrame: 5, nextAction: "read-only" })
    ])
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
    expect(JSON.stringify(model.recorder.requests[3]?.messages)).not.toContain("Read-only discipline")
  })

  it("leaves the streak running through a shell call that changed nothing", async () => {
    const { events, model } = await shell(
      [reading, reading, reading],
      [
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } }
      ]
    )

    // A command that only reads is the case `bash` is most often used for, and
    // it must not buy silence from the cap merely by being a command.
    expect(of(events, "mutation-observed").map((event) => event.mutated)).toEqual([false, false, false])
    expect(of(events, "read-only-demanded")[0]).toMatchObject({
      streak: 2,
      cap: 2,
      nextFrame: 2,
      nextAction: "read-only"
    })
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
  })

  const declaring = `await ctx.call("edit", { path: "a.py", text: "same" })
       return { intent: "continue", state: {}, context: [] }`

  it("keeps a declared write the measurement never saw, rather than failing the run", async () => {
    // The measurement is rooted at one path, prunes directories, and stops at
    // a path bound. Every edit outside what it covers looks, to the digest,
    // exactly like an idle frame — and this repository is already past the
    // bound, so its own first 50,000 paths are `.claude` and `.smithers` and
    // nothing under `packages/`. If the measurement could overrule a
    // declaration, a run editing files the whole time would be stopped as
    // `read_only_cap` at twice its cap. It cannot: a measurement adds
    // mutations and never removes one.
    const { events, failure } = await shell(
      [declaring, declaring, declaring, declaring, declaring],
      Array.from({ length: 5 }, () => ({ _tag: "Success", value: null }) as const),
      { cap: 2, tree: "a.py=same", maxFrames: 5 }
    )

    const observed = of(events, "mutation-observed")
    expect(observed.map((event) => event.declaredWrites)).toEqual([1, 1, 1, 1, 1])
    expect(observed.map((event) => event.mutated)).toEqual([true, true, true, true, true])
    // The basis still reports that a full measurement was available, so the
    // gap between `declaredWrites: 1` and a digest that never moved is legible
    // to a reader without being acted on.
    expect(observed.every((event) => event.basis === "observed")).toBe(true)
    expect(of(events, "read-only-demanded")).toEqual([])
    expect(failure).toBeUndefined()
  })

  it("sets aside a measurement that stopped at its path bound", async () => {
    const { events, failure } = await shell(
      [declaring, declaring, declaring, declaring, declaring],
      Array.from({ length: 5 }, () => ({ _tag: "Success", value: null }) as const),
      { cap: 2, tree: "prefix-of-the-tree", treeComplete: false, maxFrames: 5 }
    )

    // A bounded walk covers a prefix chosen by sort order. It is journaled as
    // `partial` and decides nothing: the prefix holding still says nothing
    // about the files being edited outside it, and the prefix moving is as
    // likely to be a tool's own churn.
    expect(of(events, "mutation-observed").every((event) => event.basis === "partial")).toBe(true)
    expect(of(events, "mutation-observed").map((event) => event.mutated)).toEqual([true, true, true, true, true])
    expect(failure).toBeUndefined()
  })

  it("still demands a run that neither declares nor measures a change under a bounded walk", async () => {
    const { events, model } = await shell(
      [reading, reading, reading],
      [
        { _tag: "Success", value: { exitCode: 0, stdout: "" } },
        // The prefix moves. It is not the workspace, so it decides nothing and
        // the streak runs through the frame that moved it.
        { _tag: "Success", value: { exitCode: 0, stdout: "" }, tree: "prefix-churned" },
        { _tag: "Success", value: { exitCode: 0, stdout: "" } }
      ],
      { cap: 2, tree: "prefix-of-the-tree", treeComplete: false }
    )

    expect(of(events, "mutation-observed").map((event) => event.mutated)).toEqual([false, false, false])
    expect(of(events, "read-only-demanded")[0]).toMatchObject({ streak: 2, cap: 2, nextAction: "read-only" })
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
  })

  it("falls back to declared writes, and says so, when the host measures nothing", async () => {
    const { events } = await run({
      state: state({ readOnlyCap: 2, maxFrames: 3, envelope: ["fs:read:**", "fs:write:**"] }),
      flows: [descriptor("fs/list", { capabilities: ["fs:read:**"] }), editor],
      script: [
        emits(
          `await ctx.call("edit", { path: "a.py", text: "fixed" })
           return { intent: "continue", state: {}, context: [] }`
        ),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      calls: successes(1)
    })

    // No tree was given, so `observe` reports nothing and the loop keeps the
    // old rule. The journal names the basis rather than presenting a
    // declaration as a measurement.
    expect(of(events, "mutation-observed")).toEqual([
      expect.objectContaining({ basis: "declared", mutated: true, declaredWrites: 1, digest: "", paths: 0 }),
      expect.objectContaining({ basis: "declared", mutated: false, declaredWrites: 0 })
    ])
  })

  it("measures once per frame and journals both measurements as durable boundaries", async () => {
    const { engine } = await shell(
      [reading, reading],
      [{ _tag: "Success", value: null }, { _tag: "Success", value: null }]
    )

    // The opening walk happens once, on the first frame; every later frame
    // opens on what its predecessor closed with. Both are recorded boundaries,
    // so a resumed frame replays the measurement instead of walking a tree
    // that has moved on.
    const names = engine.recorder.records.map((record) => record.name)
    expect(names.filter((name) => name === "workspace-open")).toHaveLength(1)
    expect(names.filter((name) => name === "workspace-close")).toHaveLength(2)
    expect(engine.recorder.records[0]?.identity).toMatchObject({ session: "session-1", frame: 0 })
  })

  it("clears the streak from a mutation a raised cell landed before it threw", async () => {
    const { events } = await shell(
      [
        reading,
        `await ctx.call("bash", { mode: "unhermetic", command: "sed -i s/a/b/ a.py" })
         throw new Error("boom")`,
        reading
      ],
      [
        { _tag: "Success", value: null },
        { _tag: "Success", value: null, tree: "a.py=b" },
        { _tag: "Success", value: null }
      ],
      { cap: 2, tree: "a.py=a" }
    )

    // The cell never settled a transition, so the frame judges nothing — but
    // the tree moved, and the streak must not run through a frame that
    // changed a tracked file.
    expect(of(events, "mutation-observed")[1]).toMatchObject({ basis: "observed", mutated: true })
    expect(of(events, "read-only-demanded")).toEqual([])
  })

  /** An edit the cell attempts and survives, whatever the flow answers. */
  const attempt = (text: string) =>
    `try { await ctx.call("edit", { path: "a.py", text: ${JSON.stringify(text)} }) } catch (error) {}
     return { intent: "continue", state: {}, context: [] }`

  it("lets a complete measurement veto the declaration of a call that failed", async () => {
    const { events, model } = await shell(
      [attempt("one"), attempt("two"), attempt("three"), `return { intent: "complete", state: {}, output: "done" }`],
      [
        { _tag: "Failure", message: "oldString does not occur" },
        { _tag: "Failure", message: "Failed to find expected lines" },
        { _tag: "Success", value: { edited: true } }
      ],
      { cap: 2, tree: "a.py=same", maxFrames: 4 }
    )

    // A failed call declared what it *would* have written. The workspace was
    // measured whole on both sides of the frame and did not move, so the
    // declaration is contradicted rather than merely unconfirmed, and the
    // frame is not a write. Wave 7 recorded two frames of exactly this shape,
    // each clearing a read-only streak the run had not broken.
    const observed = of(events, "mutation-observed")
    expect(observed.slice(0, 2)).toEqual([
      expect.objectContaining({ basis: "observed", mutated: false, declaredWrites: 1 }),
      expect.objectContaining({ basis: "observed", mutated: false, declaredWrites: 1 })
    ])
    // The successful edit still counts on the same unchanged digest: the
    // measurement is rooted, pruned and bounded, so it may contradict a call
    // that reported failure and never a call that reported success.
    expect(observed[2]).toMatchObject({ basis: "observed", mutated: true, declaredWrites: 1 })

    // Two vetoed frames make a streak of two, which is the cap, and the frame
    // that finally edits answers the demand. Under the union rule the run
    // spent both frames looking like it was writing and was never demanded.
    expect(of(events, "read-only-demanded")).toEqual([
      expect.objectContaining({ streak: 2, cap: 2, nextFrame: 2, nextAction: "write" })
    ])
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
  })

  it("keeps a failed call's declaration where the measurement covered only a prefix", async () => {
    const { events } = await shell(
      [attempt("one"), attempt("two"), attempt("three")],
      [
        { _tag: "Failure", message: "oldString does not occur" },
        { _tag: "Failure", message: "oldString does not occur" },
        { _tag: "Failure", message: "oldString does not occur" }
      ],
      { cap: 2, tree: "prefix-of-the-tree", treeComplete: false, maxFrames: 3 }
    )

    // A bounded walk that saw a prefix hold still says nothing about the path
    // the call named, so it cannot contradict anything. The veto needs a
    // measurement that covered the tree; short of that the declaration stands
    // and the run is not stopped on the absence of evidence.
    expect(of(events, "mutation-observed").map((event) => event.mutated)).toEqual([true, true, true])
    expect(of(events, "read-only-demanded")).toEqual([])
  })
})

describe("CellTurn repeated observation", () => {
  const shell = descriptor("bash", { capabilities: ["proc:spawn:*"], tier: "irreversible" })

  /** A frame that runs one command and reports on it. */
  const running = (command: string) =>
    `await ctx.call("bash", { mode: "unhermetic", command: ${JSON.stringify(command)} })
     return { intent: "continue", state: {}, context: [{ role: "user", text: "checked" }] }`

  const spinning = (cells: ReadonlyArray<string>, calls?: ReadonlyArray<ScriptedEngine.CallStep>) =>
    run({
      // The read-only cap is disarmed so the only intervention under test is
      // the repeat demand: a spinning run is read-only too, and the two
      // controls must be legible apart.
      state: state({ maxFrames: cells.length, envelope: ["fs:read:**", "fs:write:**", "proc:spawn:*"] }),
      flows: [shell, editor],
      script: cells.map(emits),
      calls: calls ?? Array.from({ length: cells.length }, () => ({ _tag: "Success", value: null }) as const),
      tree: "a.py=fixed"
    })

  it("names the repetition and redirects a run that only re-confirms what it knows", async () => {
    const { events, model } = await spinning([
      running("git diff"),
      running("git diff"),
      running("git diff"),
      running("git diff"),
      running("git diff"),
      running("git diff")
    ])

    // Frame 0 asks something new; frames 1 to 4 ask nothing new and change
    // nothing, which is the armed threshold, so frame 5 carries the notice.
    expect(of(events, "repeat-demanded")).toEqual([
      expect.objectContaining({ frames: CellTurn.defaultRepeatFrames, cap: CellTurn.defaultRepeatFrames, nextFrame: 5 })
    ])
    const demanded = JSON.stringify(model.recorder.requests[5]?.messages)
    expect(demanded).toContain("Repeated observation")
    expect(demanded).toContain("re-confirming what you already know")
    expect(demanded).toContain("the failing check itself")
    expect(demanded).toContain("git blame")
    expect(JSON.stringify(model.recorder.requests[4]?.messages)).not.toContain("Repeated observation")
  })

  it("says nothing while the run keeps asking something new", async () => {
    const { events } = await spinning([
      running("git diff"),
      running("git status"),
      running("git log -1"),
      running("git blame a.py"),
      running("git diff"),
      running("git status")
    ])

    // The last two frames repeat, but every frame before them asked something
    // the run had not asked, so no streak ever forms. A demand here would fire
    // on ordinary work.
    expect(of(events, "repeat-demanded")).toEqual([])
  })

  it("says nothing while the frames that repeat are changing the workspace", async () => {
    const { events } = await spinning(
      [
        running("make fix"),
        running("make fix"),
        running("make fix"),
        running("make fix"),
        running("make fix"),
        running("make fix")
      ],
      [
        { _tag: "Success", value: null, tree: "a.py=1" },
        { _tag: "Success", value: null, tree: "a.py=2" },
        { _tag: "Success", value: null, tree: "a.py=3" },
        { _tag: "Success", value: null, tree: "a.py=4" },
        { _tag: "Success", value: null, tree: "a.py=5" },
        { _tag: "Success", value: null, tree: "a.py=6" }
      ]
    )

    // A command repeated verbatim that moves the tree every time is a run
    // making progress with one tool, not a run confirming itself. Only frames
    // that observe and change nothing count.
    expect(of(events, "mutation-observed").every((event) => event.mutated)).toBe(true)
    expect(of(events, "repeat-demanded")).toEqual([])
  })

  it("carries the count across a frame that called nothing at all", async () => {
    const { events } = await spinning([
      running("git diff"),
      running("git diff"),
      running("git diff"),
      `return { intent: "continue", state: {}, context: [{ role: "user", text: "thinking" }] }`,
      running("git diff"),
      running("git diff"),
      running("git diff")
    ])

    // A frame that issued no call made no observation, so it neither repeats
    // one nor breaks a run of them. Clearing the count there would let one
    // silent frame launder a spin; counting it would punish a frame spent
    // planning.
    expect(of(events, "repeat-demanded")).toEqual([
      expect.objectContaining({ frames: CellTurn.defaultRepeatFrames, nextFrame: 6 })
    ])
  })

  it("returns after another full threshold rather than every frame", async () => {
    const { events } = await spinning(
      Array.from({ length: 11 }, () => running("git diff"))
    )

    // Issuing the demand restarts the count, so a run that keeps repeating is
    // told once per threshold instead of once per frame.
    expect(of(events, "repeat-demanded").map((event) => event.nextFrame)).toEqual([5, 9])
  })

  it("leaves a run whose repeat demand is disarmed alone", async () => {
    const disarmed = CellTurn.make({
      session: "session-1",
      seat: "anthropic:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })],
      placement: Option.none(),
      contextWindow: window,
      maxFrames: 6,
      repeatCap: 0
    })
    const { events, model } = await run({
      state: disarmed,
      flows: [shell],
      script: Array.from({ length: 6 }, () => emits(running("git diff"))),
      tree: "a.py=fixed"
    })

    expect(of(events, "repeat-demanded")).toEqual([])
    expect(JSON.stringify(model.recorder.requests)).not.toContain("Repeated observation")
  })
})

describe("CellTurn narrowed verification", () => {
  const shell = descriptor("bash", { capabilities: ["proc:spawn:*"], tier: "irreversible" })

  /** A frame that runs one command and asks for another. */
  const running = (command: string) =>
    `await ctx.call("bash", { mode: "unhermetic", command: ${JSON.stringify(command)} })
     return { intent: "continue", state: {}, context: [{ role: "user", text: "checked" }] }`

  /** A frame that runs one command and declares the task finished. */
  const finishing = (command: string, output: string) =>
    `await ctx.call("bash", { mode: "unhermetic", command: ${JSON.stringify(command)} })
     return { intent: "complete", state: {}, output: ${JSON.stringify(output)} }`

  /** The shape this control exists for: edit, narrow the check, and finish. */
  const fixing = (command: string, output: string) =>
    `await ctx.call("edit", { path: "a.py", text: "fix" })
     await ctx.call("bash", { mode: "unhermetic", command: ${JSON.stringify(command)} })
     return { intent: "complete", state: {}, output: ${JSON.stringify(output)} }`

  const ok = (tree?: string): ScriptedEngine.CallStep =>
    tree === undefined ? { _tag: "Success", value: null } : { _tag: "Success", value: null, tree }

  const verifying = (
    cells: ReadonlyArray<string>,
    calls: ReadonlyArray<ScriptedEngine.CallStep>,
    overrides: { readonly maxFrames?: number; readonly narrowingCap?: number } = {}
  ) =>
    run({
      state: CellTurn.make({
        session: "session-1",
        seat: "anthropic:test-model",
        modelParams: ModelRequest.GenerationParams.make(),
        layers: ["layer-a"],
        capabilityEnvelope: ["fs:write:**", "proc:spawn:*"].map((declared) => {
          const parsed = declared.split(":")
          return new Capability.CapabilityPattern({
            action: `${parsed[0]}:${parsed[1]}` as Capability.PatternAction,
            resource: parsed.slice(2).join(":")
          })
        }),
        placement: Option.none(),
        contextWindow: window,
        maxFrames: overrides.maxFrames ?? cells.length,
        // The repeat demand is disarmed so the only intervention under test is
        // this one; a run that re-runs a check it already ran is repeating
        // itself by construction, and the two notices must be legible apart.
        repeatCap: 0,
        ...(overrides.narrowingCap === undefined ? {} : { narrowingCap: overrides.narrowingCap })
      }),
      flows: [shell, editor],
      script: cells.map(emits),
      calls,
      tree: "a.py=base"
    })

  it("bounces one completion whose check narrows a check the tree has moved under", async () => {
    const { events, model } = await verifying(
      [
        running("check suite"),
        fixing("check suite -k one", "narrowed"),
        finishing("check suite", "re-run in full")
      ],
      [ok(), ok("a.py=fixed"), ok(), ok()]
    )

    // The run ran the full surface once, changed the tree, and then completed
    // on a filtered version of that same command. Everything the filter
    // dropped is unmeasured on the tree the run is submitting.
    const demanded = of(events, "narrowed-demanded")
    expect(demanded).toHaveLength(1)
    expect(demanded[0]).toMatchObject({
      flow: "bash",
      broaderDigest: "a.py=base",
      currentDigest: "a.py=fixed",
      nextFrame: 2
    })
    expect(demanded[0]?.broader).toContain("check suite")
    expect(demanded[0]?.narrower).toContain("-k")

    // The demand is an in-frame observation, so the frame that answers it is
    // holding the cell it just wrote plus one sentence naming what is missing.
    const answering = JSON.stringify(model.recorder.requests[2]?.messages)
    expect(answering).toContain("Narrowed verification")
    expect(answering).toContain("byte for byte")
    expect(JSON.stringify(model.recorder.requests[1]?.messages)).not.toContain("Narrowed verification")

    // The bounced frame continues the run rather than failing it, and the
    // completion that follows the re-run is the run's answer.
    expect(of(events, "turn-closed").map((event) => event.outcome)).toEqual([
      "continue",
      "continue",
      "resolved"
    ])
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "re-run in full" })
    ])
  })

  it("accepts the next completion whatever it re-ran, and never asks twice", async () => {
    const { events } = await verifying(
      [
        running("check suite"),
        fixing("check suite -k one", "narrowed"),
        finishing("check suite -k two", "still narrowed")
      ],
      [ok(), ok("a.py=fixed"), ok(), ok()]
    )

    // The third frame narrows the same stale check again and is taken as it
    // stands. The loop names what is missing once; deciding whether the answer
    // is good enough would be the loop grading the run's evidence with its
    // own, and nothing here re-runs a command.
    expect(of(events, "narrowed-demanded")).toHaveLength(1)
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "still narrowed" })
    ])
  })

  it("accepts a completion that states why the broader check no longer applies", async () => {
    const { events, model } = await verifying(
      [
        running("check suite"),
        fixing("check suite -k one", "narrowed"),
        `return { intent: "complete", state: {}, output: "the dropped cases were deleted by this change", reason: "superseded" }`
      ],
      [ok(), ok("a.py=fixed"), ok()]
    )

    // Re-running the check and saying why it no longer applies are the two
    // ways out the demand names, and they are equals: the second runs no
    // command at all and is accepted the same way.
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain(
      "why that check no longer applies"
    )
    expect(of(events, "narrowed-demanded")).toHaveLength(1)
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "the dropped cases were deleted by this change" })
    ])
  })

  it("bounces a completion whose own frame changed nothing, when an earlier frame did", async () => {
    const { events } = await verifying(
      [
        running("check suite"),
        `await ctx.call("edit", { path: "a.py", text: "fix" })
         return { intent: "continue", state: {}, context: [{ role: "user", text: "edited" }] }`,
        finishing("check suite -k one", "narrowed"),
        finishing("check suite", "re-run in full")
      ],
      [ok(), ok("a.py=fixed"), ok(), ok()]
    )

    // The change is the run's, not the frame's. What makes the narrowed result
    // insufficient is that the broad check has not been seen on this tree, and
    // which frame moved the tree is beside the point.
    expect(of(events, "narrowed-demanded")).toEqual([
      expect.objectContaining({ nextFrame: 3, broaderDigest: "a.py=base", currentDigest: "a.py=fixed" })
    ])
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "re-run in full" })
    ])
  })

  it("says nothing when the broader check was run over the tree being submitted", async () => {
    const { events, model } = await verifying(
      [
        `await ctx.call("edit", { path: "a.py", text: "fix" })
         return { intent: "continue", state: {}, context: [{ role: "user", text: "edited" }] }`,
        running("check suite"),
        finishing("check suite -k one", "narrowed")
      ],
      [ok("a.py=fixed"), ok(), ok()]
    )

    // This is the shape of every run in the wave that resolved its instance:
    // the broad check is current, so the narrow one after it is a detail and
    // not a substitution. A demand here would cost a correct run a frame and a
    // model call for nothing.
    expect(of(events, "narrowed-demanded")).toEqual([])
    expect(model.recorder.requests).toHaveLength(3)
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "narrowed" })
    ])
  })

  it("says nothing when the frame's calls broaden the earlier check instead", async () => {
    const { events } = await verifying(
      [
        running("check a.py"),
        fixing("check a.py b.py", "widened"),
        finishing("check a.py", "unreached")
      ],
      [ok(), ok("a.py=fixed"), ok(), ok()]
    )

    // Adding a target asks about ground the earlier check never covered, which
    // is a broader question. Demanding the earlier one back would send a run
    // that widened its net to re-run the smaller one.
    expect(of(events, "narrowed-demanded")).toEqual([])
  })

  it("never carries a call that is content rather than a question into the ledger", async () => {
    const payload = Array.from({ length: CellTurn.defaultMaxFrames * 3 }, (_, index) => `term${index}`).join(" ")
    const { events } = await verifying(
      [
        running(payload),
        fixing(`${payload} -k one`, "narrowed"),
        finishing("check suite", "unreached")
      ],
      [ok(), ok("a.py=fixed"), ok(), ok()]
    )

    // An input carrying a payload is not a check anybody re-runs with a filter
    // on it, and storing its terms would put the payload in controller state
    // twice. It is never recorded, so it can never be demanded back.
    expect(payload.split(" ")).toHaveLength(CellTurn.defaultMaxFrames * 3)
    expect(of(events, "narrowed-demanded")).toEqual([])
  })

  it("takes the completion rather than the demand when no frame is left to spend", async () => {
    const { events } = await verifying(
      [running("check suite"), fixing("check suite -k one", "narrowed")],
      [ok(), ok("a.py=fixed"), ok()],
      { maxFrames: 2 }
    )

    // A demand needs a frame to be answered in. Spending the run's last frame
    // on a notice nobody can act on would lose the answer to make a point
    // about it, so the completion stands and the record shows no demand.
    expect(of(events, "narrowed-demanded")).toEqual([])
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "narrowed" })
    ])
  })

  it("leaves a run whose narrowing demand is disarmed alone", async () => {
    const { events } = await verifying(
      [running("check suite"), fixing("check suite -k one", "narrowed")],
      [ok(), ok("a.py=fixed"), ok()],
      { narrowingCap: 0 }
    )

    expect(of(events, "narrowed-demanded")).toEqual([])
    expect(of(events, "discipline-armed")[0]?.narrowingCap).toBe(0)
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({ text: "narrowed" })
    ])
  })

  it("gives the bounced completion back when the answering frame ends on the budget", async () => {
    const { events } = await verifying(
      [
        running("check suite"),
        fixing("check suite -k one", "the run's own answer"),
        `throw new Error("the answering frame broke")`
      ],
      [ok(), ok("a.py=fixed"), ok()]
    )

    // Reserving a frame is not the same as being answered in it. The demand
    // is allowed to take a finished answer away only because the run gets to
    // give one again, so the run must not be able to end holding nothing: the
    // budget still reports that it ended the run, and the answer the
    // controller took is what the run ends on.
    expect(of(events, "narrowed-demanded")).toHaveLength(1)
    const resolved = of(events, "resolved")[0]?.message.content
    expect(resolved).toEqual([
      expect.objectContaining({ text: expect.stringContaining("the run's own answer") })
    ])
    expect(resolved).toEqual([
      expect.objectContaining({ text: expect.stringContaining("frame budget of 3 is exhausted") })
    ])
  })

  it("reports only the budget when no completion was ever bounced", async () => {
    const { events } = await verifying(
      [running("check suite"), `throw new Error("nothing was ever completed")`],
      [ok(), ok()]
    )

    // The other half of the same rule: a run that never completed has nothing
    // to give back, and the notice says exactly that and nothing more.
    expect(of(events, "narrowed-demanded")).toEqual([])
    expect(of(events, "resolved")[0]?.message.content).toEqual([
      expect.objectContaining({
        text: "The frame budget of 2 is exhausted. The run stops here; the last transition was a request to continue."
      })
    ])
  })
})

describe("CellTurn call latency", () => {
  it("journals the wall-clock duration of each sealed model call from the injected clock", async () => {
    const { events } = await run({
      state: state({ maxFrames: 2 }),
      script: [
        emits(`return { intent: "continue", state: {}, context: [{ role: "user", text: "on it" }] }`),
        emits(`return { intent: "complete", state: {}, output: "done" }`)
      ],
      clock: tickingClock(250)
    })

    // One tick before the step and one after, on the clock the run was given
    // rather than the host's wall time.
    expect(of(events, "model-settled").map((event) => event.durationMillis)).toEqual([250, 250])
  })
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

describe("CellTurn truncated output", () => {
  /** A shell capture the flow reports as cut, exactly as `Bash` shapes one. */
  const captured = "def visit(node):\n    return node\n".repeat(80)
  const truncatedShellResult = {
    _tag: "Success",
    value: {
      exitCode: 0,
      stdout: captured,
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: false,
      stdoutDroppedBytes: 24_071,
      stderrDroppedBytes: 0
    }
  } as const
  const restoreFlows = [
    descriptor("bash"),
    descriptor("write", { tier: "compensable", writes: ["/**"] }),
    descriptor("grep")
  ]
  const restoring = (target: string) =>
    `const out = await ctx.call("bash", { mode: "unhermetic", command: "git show HEAD:src/module.py" })
     try {
       await ctx.call(${JSON.stringify(target)}, { path: "src/module.py", content: out.stdout })
       return { intent: "complete", output: "wrote the file" }
     } catch (error) {
       return { intent: "complete", output: "refused: " + error.message }
     }`

  it("refuses a write of bytes a call already returned truncated", async () => {
    const { engine, events } = await run({
      script: [emits(restoring("write"))],
      flows: restoreFlows,
      calls: [truncatedShellResult]
    })

    // The write never reached the engine, so the file on disk is untouched.
    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["bash"])
    expect(of(events, "cell-call-started")).toHaveLength(1)

    const resolved = of(events, "resolved")[0]?.message.content[0]
    const text = resolved?.type === "text" ? resolved.text : ""
    expect(text).toContain("refused:")
    expect(text).toContain("byte-identical")
    expect(text).toContain("bash cut stdout and dropped 24071 bytes")
    expect(text).toContain("git checkout or git restore")
  })

  it("refuses on the declared write set rather than on the flow's name", async () => {
    const { engine } = await run({
      script: [emits(restoring("fs/store"))],
      flows: [...restoreFlows, descriptor("fs/store", { tier: "compensable", writes: ["/**"] })],
      calls: [truncatedShellResult]
    })

    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["bash"])
  })

  it("refuses the same bytes a frame later, carried through durable state", async () => {
    const { engine, events } = await run({
      state: state({ maxFrames: 3 }),
      script: [
        emits(
          `const out = await ctx.call("bash", { mode: "unhermetic", command: "git show HEAD:src/module.py" })
           return {
             intent: "continue",
             state: { captured: out.stdout },
             context: [{ role: "user", text: "restore the module" }]
           }`
        ),
        emits(
          `try {
             await ctx.call("write", { path: "src/module.py", content: ctx.state.captured })
             return { intent: "complete", output: "wrote the file" }
           } catch (error) {
             return { intent: "complete", output: "refused: " + error.message }
           }`
        )
      ],
      flows: restoreFlows,
      calls: [truncatedShellResult]
    })

    // The ledger is controller state, so a fragment stashed in `state` is still
    // recognised on the frame that finally writes it.
    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["bash"])
    const resolved = of(events, "resolved")[0]?.message.content[0]
    expect(resolved?.type === "text" ? resolved.text : "").toContain("refused:")
  })

  it("leaves the read-only streak running through a refused restore", async () => {
    const { events, model } = await run({
      state: state({ readOnlyCap: 2, maxFrames: 5 }),
      script: [
        emits(
          `await ctx.call("bash", { mode: "unhermetic", command: "git show HEAD:src/module.py" })
           return { intent: "continue", state: {}, context: [] }`
        ),
        emits(
          `const out = await ctx.call("bash", { mode: "unhermetic", command: "git show HEAD:src/module.py" })
           try { await ctx.call("write", { path: "src/module.py", content: out.stdout }) } catch (error) {}
           return { intent: "continue", state: {}, context: [] }`
        ),
        emits(`return { intent: "complete", output: "done" }`)
      ],
      flows: restoreFlows,
      calls: [truncatedShellResult, truncatedShellResult]
    })

    // The truncated-write guard lands on exactly the calls the read-only cap
    // watches, so a run whose only edit is refused would otherwise have its
    // streak cleared by a write that never happened — and go quiet through the
    // stall the cap exists to break.
    expect(of(events, "read-only-demanded")[0]).toMatchObject({ streak: 2, cap: 2, nextAction: "read-only" })
    expect(JSON.stringify(model.recorder.requests[2]?.messages)).toContain("Read-only discipline")
  })

  it("performs a large write that is not a fragment the run was handed", async () => {
    const { engine, events } = await run({
      script: [
        emits(
          `await ctx.call("bash", { mode: "unhermetic", command: "git show HEAD:src/module.py" })
           const generated = "print('generated')\\n".repeat(4000)
           await ctx.call("write", { path: "src/generated.py", content: generated })
           return { intent: "complete", output: "wrote " + generated.length + " characters" }`
        )
      ],
      flows: restoreFlows,
      calls: [truncatedShellResult, { _tag: "Success", value: { path: "src/generated.py" } }]
    })

    // Size is not the signal; provenance is. A 76,000-character file the cell
    // composed itself is written without argument.
    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["bash", "write"])
    const written = engine.recorder.calls[1]?.input as { readonly content: string }
    expect(written.content).toHaveLength(76_000)
    const resolved = of(events, "resolved")[0]?.message.content[0]
    expect(resolved?.type === "text" ? resolved.text : "").toBe("wrote 76000 characters")
  })

  it("passes a truncated capture to a call that writes nothing", async () => {
    const { engine } = await run({
      script: [
        emits(
          `const out = await ctx.call("bash", { mode: "unhermetic", command: "git show HEAD:src/module.py" })
           const hits = await ctx.call("grep", { pattern: "def visit", text: out.stdout })
           return { intent: "complete", output: JSON.stringify(hits) }`
        )
      ],
      flows: restoreFlows,
      calls: [truncatedShellResult, { _tag: "Success", value: { matches: 80 } }]
    })

    // Searching, diffing, or summarising a fragment is ordinary use of what the
    // flow returned; only a write of it is refused.
    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["bash", "grep"])
    expect((engine.recorder.calls[1]?.input as { readonly text: string }).text).toBe(captured)
  })

  it("compiles the restore teaching into the taught system prefix", () => {
    const system = ContextWindow.render(CellTurn.teach(window, [descriptor("bash")])).system
      .map((part) => part.text)
      .join("\n")

    expect(system).toContain("never route file content through captured stdout")
    expect(system).toContain("git checkout or git restore")
  })
})
