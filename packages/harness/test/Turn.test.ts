/**
 * Pi §§6–7 and OpenCode session-runner parity:
 * `docs/specs/Research/Pi Reference Findings 2026-07-27.md`.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { Capability, Permission } from "@smthrs/kernel-next"
import { Model, ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Elaborate from "../src/Elaborate.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Plan from "../src/Plan.ts"
import * as Steering from "../src/Steering.ts"
import * as Tokens from "../src/Tokens.ts"
import * as Turn from "../src/Turn.ts"
import { make as makeEngine } from "./fixtures/scriptedEngine.ts"
import {
  lengthStop,
  make as makeModel,
  midStreamInterrupt,
  type Step,
  stopNoTools,
  stopWithToolCalls
} from "./fixtures/scriptedModel.ts"

const alpha = ModelRequest.ToolDefinition.make({
  name: "alpha",
  description: "Run alpha",
  parameters: {}
})
const beta = ModelRequest.ToolDefinition.make({
  name: "beta",
  description: "Run beta",
  parameters: {}
})

const context = (): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: "model",
    segments: [
      {
        kind: "system",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "system" })]
      },
      {
        kind: "tools",
        zone: "prefix",
        content: [alpha, beta]
      },
      {
        kind: "transcript",
        zone: "tail",
        content: [ModelRequest.Message.user("start")]
      }
    ],
    activeTools: ["alpha", "beta"]
  })

const compactionContext = (): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: "model",
    segments: [
      {
        kind: "system",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "system" })]
      },
      {
        kind: "tools",
        zone: "prefix",
        content: [alpha, beta]
      },
      ...["oldest", "older", "recent"].map((value) => ({
        kind: "transcript" as const,
        zone: "tail" as const,
        content: [ModelRequest.Message.user(value)],
        tokens: new Tokens.Count({ value: 100_000, estimated: true })
      }))
    ],
    activeTools: ["alpha", "beta"]
  })

const catalog: Elaborate.Catalog = {
  tools: {
    alpha: {
      flowName: "alpha",
      input: Schema.Struct({ value: Schema.String }),
      capabilities: ["fs:read:/workspace/**"],
      effects: {
        reads: ["/workspace/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.some("local")
    },
    beta: {
      flowName: "beta",
      input: Schema.Struct({ value: Schema.String }),
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none()
    }
  }
}

const result = (
  callId: string,
  content: string,
  outcome: Plan.ChildResult["outcome"] = "success"
): Plan.ChildResult =>
  new Plan.ChildResult({
    callId,
    outcome,
    result: ModelRequest.ToolResultPart.make({
      toolCallId: callId,
      content
    })
  })

const run = (
  engineLayer: Layer.Layer<EngineLike.EngineLike>,
  steeringLayer: Layer.Layer<Steering.Source> = Steering.layerNoop(),
  options: {
    readonly contextWindow?: ContextWindow.ContextWindow | undefined
    readonly frame?: number | undefined
    readonly maxFrames?: number | undefined
    readonly contextWindowTokens?: number | undefined
  } = {}
) =>
  Turn.run({
    state: Turn.make({
      seat: "sdk:model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["model:test"],
      capabilityEnvelope: [
        new Capability.CapabilityPattern({
          action: "model:call",
          resource: "provider.test/**"
        })
      ],
      placement: Option.some("local"),
      contextWindow: options.contextWindow ?? context(),
      frame: options.frame,
      maxFrames: options.maxFrames,
      contextWindowTokens: options.contextWindowTokens
    }),
    catalog
  }).pipe(
    Stream.runCollect,
    Effect.provide(engineLayer),
    Effect.provide(steeringLayer),
    Effect.map((events) => Array.from(events))
  )

const twoCalls: Step = {
  events: [
    ModelEvent.ModelEvent.ToolCallStart({
      type: "tool-call-start",
      id: "a",
      name: "alpha"
    }),
    ModelEvent.ModelEvent.ToolCallDelta({
      type: "tool-call-delta",
      id: "a",
      arguments: "{\"value\":\"one\"}"
    }),
    ModelEvent.ModelEvent.ToolCallEnd({
      type: "tool-call-end",
      id: "a"
    }),
    ModelEvent.ModelEvent.ToolCallStart({
      type: "tool-call-start",
      id: "b",
      name: "beta"
    }),
    ModelEvent.ModelEvent.ToolCallDelta({
      type: "tool-call-delta",
      id: "b",
      arguments: "{\"value\":\"two\"}"
    }),
    ModelEvent.ModelEvent.ToolCallEnd({
      type: "tool-call-end",
      id: "b"
    }),
    ModelEvent.ModelEvent.Settle({
      type: "settle",
      stopReason: "tool-calls"
    })
  ]
}

/**
 * Overflow as the provider adapter reports it: the typed `context_overflow`
 * code. The wire prose is carried along, but nothing in the harness reads it.
 */
const contextOverflow = (): ModelError.ModelError =>
  new ModelError.ModelError({
    code: "context_overflow",
    providerCode: "context_length_exceeded",
    message: "This model's maximum context length was exceeded"
  })

/**
 * The same prose, classified by the adapter as an ordinary bad request.
 *
 * Recovery must not fire here: a harness that re-read the message would compact
 * and retry a request that will fail again for a reason compaction cannot fix.
 */
const overflowShapedBadRequest = (): ModelError.ModelError =>
  new ModelError.ModelError({
    code: "invalid_request",
    providerCode: "invalid_request_error",
    message: "This model's maximum context length was exceeded"
  })

describe("Turn", () => {
  it("unfolds multiple engine frames until a stop without tool calls", async () => {
    const model = makeModel([stopWithToolCalls, stopNoTools])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [result("call-1", "alpha result")]
      }
    ])
    const events = await Effect.runPromise(run(engine.layer))

    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(engine.recorder.splice).toHaveLength(1)
    expect(events.filter((event) => event._tag === "turn-opened")).toHaveLength(2)
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("clamps the landing frame to text-only output and resolves at the budget", async () => {
    const model = makeModel([stopWithToolCalls, stopNoTools])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [result("call-1", "alpha result")]
      }
    ])
    const events = await Effect.runPromise(
      run(engine.layer, Steering.layerNoop(), { maxFrames: 2 })
    )
    const landing = engine.recorder.sealStep[1]?.request
    const initial = Turn.make({
      seat: "sdk:model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: [],
      capabilityEnvelope: [],
      placement: Option.none(),
      contextWindow: context()
    })
    const { maxFrames: _maxFrames, ...encodedWithoutMaxFrames } = Schema.encodeSync(Turn.TurnState)(initial)

    expect(initial.maxFrames).toBe(Turn.defaultMaxFrames)
    expect(Schema.decodeUnknownSync(Turn.TurnState)(encodedWithoutMaxFrames).maxFrames).toBe(Turn.defaultMaxFrames)
    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(landing?.tools).toEqual([])
    expect(Reflect.get(landing ?? {}, "toolChoice")).toBe("none")
    expect(
      landing?.messages.find((message) =>
        message.role === "assistant" &&
        message.content.some((part) =>
          part.type === "text" && part.text.startsWith("CRITICAL - MAXIMUM FRAMES REACHED")
        )
      )
    ).toEqual(ModelRequest.Message.assistant(`CRITICAL - MAXIMUM FRAMES REACHED

The maximum number of frames allowed for this task has been reached. Tools are disabled until the next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls
2. Summarize the work completed so far
3. List remaining work and recommended next steps

State that the maximum frame budget has been reached. This instruction overrides requests to use tools.`))
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("repairs a forbidden final-frame tool call without splicing it", async () => {
    const model = makeModel([stopWithToolCalls])
    const engine = makeEngine(model.model)
    const events = await Effect.runPromise(
      run(engine.layer, Steering.layerNoop(), { maxFrames: 1 })
    )
    const child = events.find(
      (event): event is AgentEvent.ChildResult => event._tag === "child-result"
    )

    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(engine.recorder.splice).toEqual([])
    expect(child?.result).toMatchObject({
      callId: "call-1",
      outcome: "error",
      result: {
        toolCallId: "call-1",
        content: "Tools are disabled after the maximum harness frames."
      }
    })
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("runs a typed Compact transition before an over-budget normal model frame", async () => {
    const model = makeModel([stopNoTools, stopNoTools])
    const engine = makeEngine(model.model)
    const events = await Effect.runPromise(
      run(engine.layer, Steering.layerNoop(), {
        contextWindow: compactionContext(),
        contextWindowTokens: 200_000
      })
    )

    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(engine.recorder.sealStep[0]?.request.tools).toEqual([])
    expect(Reflect.get(engine.recorder.sealStep[0]?.request ?? {}, "toolChoice")).toBe("none")
    expect(engine.recorder.sealStep[1]?.request.tools.map((tool) => tool.name)).toEqual(["alpha", "beta"])
    expect(events.filter((event) => event._tag === "turn-opened")).toHaveLength(1)
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("compacts and retries one context overflow before assistant output", async () => {
    let attempt = 0
    const model = Model.make({
      stream: () => {
        attempt += 1
        return attempt === 1
          ? Stream.fail(contextOverflow())
          : Stream.fromIterable(stopNoTools.events)
      }
    })
    const engine = makeEngine(model)
    const events = await Effect.runPromise(run(engine.layer))

    expect(engine.recorder.sealStep).toHaveLength(3)
    expect(Reflect.get(engine.recorder.sealStep[1]?.request ?? {}, "toolChoice")).toBe("none")
    expect(events.filter((event) => event._tag === "turn-opened")).toHaveLength(2)
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("fails a second context overflow after the one-shot recovery", async () => {
    let attempt = 0
    const model = Model.make({
      stream: () => {
        attempt += 1
        return attempt === 2
          ? Stream.fromIterable(stopNoTools.events)
          : Stream.fail(contextOverflow())
      }
    })
    const engine = makeEngine(model)
    const exit = await Effect.runPromiseExit(run(engine.layer))

    expect(engine.recorder.sealStep).toHaveLength(3)
    expect(exit._tag).toBe("Failure")
  })

  it("branches on the typed overflow code, not on a message that reads like one", async () => {
    let attempt = 0
    const model = Model.make({
      stream: () => {
        attempt += 1
        return attempt === 1
          ? Stream.fail(overflowShapedBadRequest())
          : Stream.fromIterable(stopNoTools.events)
      }
    })
    const engine = makeEngine(model)
    const exit = await Effect.runPromiseExit(run(engine.layer))

    // One sealed step and no compaction step: the harness never read the prose.
    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(exit._tag).toBe("Failure")
  })

  it("does not recover a context overflow after assistant output", async () => {
    const model = Model.make({
      stream: () =>
        Stream.concat(
          Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "partial" }),
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "partial", text: "partial" })
          ]),
          Stream.fail(contextOverflow())
        )
    })
    const engine = makeEngine(model)
    const exit = await Effect.runPromiseExit(run(engine.layer))

    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(exit._tag).toBe("Failure")
  })

  it("promotes one queued follow-up at idle and resets its frame budget", async () => {
    const model = makeModel([stopNoTools, stopNoTools])
    const engine = makeEngine(model.model)
    let queue = Steering.enqueue(Steering.empty(), {
      _tag: "Insert",
      delivery: "queue",
      admittedAt: 1,
      message: ModelRequest.Message.user("follow up")
    })
    const steering = Steering.layer({
      read: () => Effect.succeed(queue),
      drain: (input) =>
        Effect.sync(() => {
          const drained = Steering.drainBoundary(queue, input)
          queue = drained.remaining
          return drained
        })
    })
    const events = await Effect.runPromise(
      run(engine.layer, steering, { frame: 1, maxFrames: 2 })
    )

    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(Reflect.get(engine.recorder.sealStep[0]?.request ?? {}, "toolChoice")).toBe("none")
    expect(Reflect.get(engine.recorder.sealStep[1]?.request ?? {}, "toolChoice")).toBeUndefined()
    expect(engine.recorder.sealStep[1]?.request.tools.map((tool) => tool.name)).toEqual(["alpha", "beta"])
    expect(engine.recorder.sealStep[1]?.request.messages).toContainEqual(
      ModelRequest.Message.user("follow up")
    )
    expect(events.filter((event) => event._tag === "resolved")).toHaveLength(1)
  })

  it("hands the whole batch to EngineLike.splice and publishes the plan first", async () => {
    const model = makeModel([stopWithToolCalls, stopNoTools])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [result("call-1", "alpha result")]
      }
    ])
    const events = await Effect.runPromise(run(engine.layer))
    const elaborated = events.findIndex((event) => event._tag === "elaborated")
    const child = events.findIndex((event) => event._tag === "child-result")

    expect(engine.recorder.splice).toHaveLength(1)
    expect(engine.recorder.splice[0]?.children.map((item) => item.callId)).toEqual(["call-1"])
    expect(engine.recorder.startedCallIds).toEqual(["call-1"])
    expect(elaborated).toBeGreaterThan(-1)
    expect(child).toBeGreaterThan(elaborated)
  })

  it("accepts a cache-hit sealed message path without consulting Model directly", async () => {
    const cached = makeModel([stopNoTools])
    const engine = makeEngine(cached.model)
    const events = await Effect.runPromise(run(engine.layer))

    expect(engine.recorder.sealStep).toHaveLength(1)
    expect(cached.recorder.requests).toHaveLength(1)
    expect(engine.recorder.sealStep[0]).toMatchObject({
      request: { modelId: "model" }
    })
    expect(engine.recorder.sealStep[0]?.keyMaterial).toMatchObject({
      layers: ["model:test"],
      capabilities: ["model:call:provider.test/**"]
    })
    expect(engine.recorder.sealStep[0]?.keyMaterial.inputs).toContainEqual({
      _tag: "Literal",
      value: { contextDigest: context().digest }
    })
    expect(events.some((event) => event._tag === "model-settled")).toBe(true)
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("publishes model deltas before the sealed stream settles", async () => {
    const model = makeModel([midStreamInterrupt])
    const engine = makeEngine(model.model)
    const events = await Effect.runPromise(
      Turn.run({
        state: Turn.make({
          seat: "sdk:model",
          modelParams: ModelRequest.GenerationParams.make(),
          layers: ["model:test"],
          capabilityEnvelope: [],
          placement: Option.none(),
          contextWindow: context()
        }),
        catalog
      }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(engine.layer),
        Effect.provide(Steering.layerNoop()),
        Effect.map((items) => Array.from(items))
      )
    )

    expect(events.map((event) => event._tag)).toEqual([
      "turn-opened",
      "model-delta"
    ])
  })

  it("turns a length stop into error results without splicing children", async () => {
    const model = makeModel([lengthStop, stopNoTools])
    const engine = makeEngine(model.model)
    const events = await Effect.runPromise(run(engine.layer))
    const child = events.find(
      (event): event is AgentEvent.ChildResult => event._tag === "child-result"
    )

    expect(engine.recorder.splice).toEqual([])
    expect(child?.result.callId).toBe("length-call")
    expect(child?.result.outcome).toBe("error")
    expect(events.at(-1)?._tag).toBe("resolved")
  })

  it("keeps mid-turn steering out of the in-flight request and adds it to the next", async () => {
    const model = makeModel([stopNoTools, stopNoTools])
    const engine = makeEngine(model.model)
    let queue = Steering.enqueue(Steering.empty(), {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: 1,
      message: ModelRequest.Message.user("steer next")
    })
    const steering = Steering.layer({
      read: () => Effect.succeed(queue),
      drain: (input) =>
        Effect.sync(() => {
          const drained = Steering.drainBoundary(queue, input)
          queue = drained.remaining
          return drained
        })
    })
    await Effect.runPromise(run(engine.layer, steering))

    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(engine.recorder.sealStep[0]?.request.messages).not.toContainEqual(
      ModelRequest.Message.user("steer next")
    )
    expect(engine.recorder.sealStep[1]?.request.messages).toContainEqual(
      ModelRequest.Message.user("steer next")
    )
  })

  it("restores provider call order after out-of-order child completion", async () => {
    const model = makeModel([twoCalls, stopNoTools])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [result("b", "second"), result("a", "first")]
      }
    ])
    const events = await Effect.runPromise(run(engine.layer))
    const childResults = events.filter(
      (event): event is AgentEvent.ChildResult => event._tag === "child-result"
    )
    const secondRequest = engine.recorder.sealStep[1]?.request
    const toolMessage = secondRequest?.messages.find((message) => message.role === "tool")

    expect(childResults.map((event) => event.result.callId)).toEqual(["a", "b"])
    expect(toolMessage?.content.map((part) => part.toolCallId)).toEqual(["a", "b"])
  })

  it("maps a permission-required splice outcome to engine suspension", async () => {
    const model = makeModel([stopWithToolCalls])
    const request = new Permission.PermissionRequired({
      requestId: "permission-1",
      capability: new Capability.Capability({
        action: "fs:read",
        resource: "/workspace"
      }),
      tier: "sealed",
      meta: {}
    })
    const engine = makeEngine(model.model, [{ _tag: "PermissionRequired", request }])
    const observed: Array<AgentEvent.AgentEvent> = []
    const exit = await Effect.runPromiseExit(
      Turn.run({
        state: Turn.make({
          seat: "sdk:model",
          modelParams: ModelRequest.GenerationParams.make(),
          layers: ["model:test"],
          capabilityEnvelope: [],
          placement: Option.none(),
          contextWindow: context()
        }),
        catalog
      }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            observed.push(event)
          })
        ),
        Stream.runDrain,
        Effect.provide(engine.layer),
        Effect.provide(Steering.layerNoop())
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(observed.some((event) => event._tag === "permission-required")).toBe(true)
    expect(engine.recorder.suspend).toHaveLength(1)
    expect(engine.recorder.suspend[0]?.code).toBe("permission-required")
  })

  it("maps a typed model permission request to suspension without losing metadata", async () => {
    const request = new Permission.PermissionRequired({
      requestId: "permission-model-1",
      runId: "run-9",
      capability: new Capability.Capability({
        action: "model:call",
        resource: "provider.test/model"
      }),
      tier: "sealed",
      meta: { provider: "provider.test", attempt: 2 }
    })
    const suspended: Array<EngineLike.SuspendReason> = []
    const engine = EngineLike.make({
      sealStep: () => Stream.fail(request),
      splice: () => Stream.fromEffect(Effect.die("model permission must suspend before splice")),
      call: () => Effect.die("this fixture drives the tool-call path, not cells"),
      record: (boundary) => boundary.execute,
      suspend: (reason) => {
        suspended.push(reason)
        return Effect.die("suspended")
      }
    })
    const observed: Array<AgentEvent.AgentEvent> = []

    await Effect.runPromiseExit(
      Turn.run({
        state: Turn.make({
          seat: "sdk:model",
          modelParams: ModelRequest.GenerationParams.make(),
          layers: ["model:test"],
          capabilityEnvelope: [],
          placement: Option.none(),
          contextWindow: context()
        }),
        catalog
      }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            observed.push(event)
          })
        ),
        Stream.runDrain,
        Effect.provide(EngineLike.layer(engine)),
        Effect.provide(Steering.layerNoop())
      )
    )

    expect(observed.find((event) => event._tag === "permission-required")).toMatchObject({
      request
    })
    expect(observed.at(-1)).toMatchObject({
      _tag: "turn-closed",
      stopReason: "error",
      outcome: "suspended"
    })
    expect(suspended).toHaveLength(1)
    expect(suspended[0]).toMatchObject({
      code: "permission-required",
      details: request
    })
  })

  it("matches the journaled-moments order for a complete tool turn", async () => {
    const model = makeModel([stopWithToolCalls, stopNoTools])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [result("call-1", "alpha result")]
      }
    ])
    const events = await Effect.runPromise(run(engine.layer))
    const firstTurn = events.slice(0, events.findIndex((event) => event._tag === "turn-closed") + 1)
    const tags = firstTurn.map((event) => event._tag)

    expect(tags[0]).toBe("turn-opened")
    expect(tags.indexOf("model-delta")).toBeGreaterThan(tags.indexOf("turn-opened"))
    expect(tags.indexOf("model-settled")).toBeGreaterThan(tags.indexOf("model-delta"))
    expect(tags.indexOf("elaborated")).toBeGreaterThan(tags.indexOf("model-settled"))
    expect(tags.indexOf("child-result")).toBeGreaterThan(tags.indexOf("elaborated"))
    expect(tags.indexOf("steering-drained")).toBeGreaterThan(tags.indexOf("child-result"))
    expect(tags.at(-1)).toBe("turn-closed")
  })
})
