import { Capability } from "@smthrs/kernel"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor, Registry } from "@smthrs/registry"
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as AgentStep from "../src/AgentStep.ts"
import * as Harness from "../src/Harness.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Public from "../src/index.ts"
import * as LegacyHarness from "../src/LegacyHarness.ts"
import * as Plan from "../src/Plan.ts"
import * as Steering from "../src/Steering.ts"
import * as Visibility from "../src/Visibility.ts"
import { entry } from "./fixtures/journal.ts"
import { make as makeEngine } from "./fixtures/scriptedEngine.ts"
import {
  make as makeModel,
  midStreamInterrupt,
  type Step,
  stopNoTools,
  stopWithToolCalls
} from "./fixtures/scriptedModel.ts"

const descriptor = (name: string): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `Run ${name}`,
    body: new Descriptor.BodyRefMarkdown({
      path: `/flows/${name}/flow.mdx`,
      baseDirectory: `/flows/${name}`
    }),
    input: new Descriptor.SchemaRefNone({}),
    output: new Descriptor.SchemaRefNone({}),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}/flow.mdx`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({
      source: "test",
      root: "/flows"
    })
  })

const registryLayer = (
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor>,
  calls?: Array<string>
): Layer.Layer<Registry.Registry> =>
  Layer.succeed(
    Registry.Registry,
    Registry.makeNoop({
      list: () => {
        calls?.push("list")
        return Effect.succeed(descriptors)
      },
      visible: () => {
        calls?.push("visible")
        return Effect.succeed(descriptors)
      },
      get: (name) => {
        calls?.push("get")
        const entry = descriptors.find((item) => item.name === name)
        return entry === undefined ? Effect.die("missing test descriptor") : Effect.succeed(entry)
      },
      refresh: () => {
        calls?.push("refresh")
        return Effect.void
      },
      warnings: () => {
        calls?.push("warnings")
        return Effect.succeed([])
      }
    })
  )

const step = (): AgentStep.AgentStep =>
  new AgentStep.AgentStep({
    seat: "sdk:model",
    thinkingLevel: "low",
    layers: ["model:test"],
    capabilityEnvelope: [
      new Capability.CapabilityPattern({
        action: "*",
        resource: "*"
      })
    ],
    placement: Option.none(),
    input: { task: "test" },
    system: new AgentStep.TextDeclaration({
      text: "",
      digest: "system-digest"
    }),
    instructions: [
      new AgentStep.TextDeclaration({
        text: "Follow the test script.",
        digest: "instructions-digest"
      })
    ],
    prompt: new AgentStep.TextDeclaration({
      text: "Run the requested flow.",
      digest: "prompt-digest"
    }),
    journal: [],
    activeToolNames: [],
    toolDefinitions: []
  })

const host = Layer.empty as AgentStep.HostLike

const childResult = (
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

const makeHarness = (
  model: ReturnType<typeof makeModel>,
  engine: ReturnType<typeof makeEngine>,
  descriptors: ReadonlyArray<Descriptor.FlowDescriptor> = [descriptor("alpha")],
  options: LegacyHarness.MakeOptions = {},
  calls?: Array<string>
): Effect.Effect<Harness.Harness> =>
  LegacyHarness.make(options).pipe(
    Effect.provide(model.layer),
    Effect.provide(engine.layer),
    Effect.provide(registryLayer(descriptors, calls)),
    Effect.provide(Steering.layerNoop())
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

const interrupt = (
  harness: Harness.Harness,
  observed: Array<AgentEvent.AgentEvent>
) =>
  harness.run(step(), host).pipe(
    Stream.tap((event) =>
      Effect.sync(() => {
        observed.push(event)
      })
    ),
    Stream.runDrain,
    Effect.exit
  )

const errorFrom = (
  exit:
    | { readonly _tag: "Success"; readonly value: unknown }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<HarnessError> }
): HarnessError | undefined =>
  exit._tag === "Failure"
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined

describe("Harness", () => {
  it("emits the complete end-to-end AgentEvent sequence in order", async () => {
    const model = makeModel([stopWithToolCalls, stopNoTools])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [childResult("call-1", "alpha result")]
      }
    ])
    const harness = await Effect.runPromise(makeHarness(model, engine))
    const events = await Effect.runPromise(
      harness.run(step(), host).pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items))
      )
    )

    expect(events.map((event) => event._tag)).toEqual([
      "turn-opened",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-settled",
      "elaborated",
      "child-result",
      "steering-drained",
      "turn-closed",
      "turn-opened",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-delta",
      "model-settled",
      "elaborated",
      "steering-drained",
      "turn-closed",
      "resolved"
    ])
  })

  it("makeNoop fails with a typed invalid-step error", async () => {
    const exit = await Effect.runPromiseExit(
      Harness.makeNoop().run(step(), host).pipe(Stream.runDrain)
    )

    expect(errorFrom(exit)?.code).toBe("invalid_step")
  })

  it("uses its emitted stream as the only side channel", async () => {
    const calls: Array<string> = []
    const model = makeModel([stopNoTools])
    const engine = makeEngine(model.model)
    const harness = await Effect.runPromise(makeHarness(model, engine, [descriptor("alpha")], {}, calls))
    const events = await Effect.runPromise(
      harness.run(step(), host).pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items))
      )
    )

    expect(events.length).toBeGreaterThan(0)
    expect(calls).toEqual(["visible"])
    expect(engine.recorder.splice).toEqual([])
  })

  it("filters registry disclosure with the current seat visibility policy", async () => {
    const model = makeModel([stopNoTools])
    const engine = makeEngine(model.model)
    const harness = await Effect.runPromise(
      makeHarness(
        model,
        engine,
        [descriptor("alpha"), descriptor("private-beta")],
        {
          visibility: [
            Visibility.make({
              name: "sdk:model",
              rules: [
                new Visibility.Rule({ effect: "allow", pattern: "*" }),
                new Visibility.Rule({ effect: "deny", pattern: "private-*" })
              ]
            })
          ]
        }
      )
    )

    await Effect.runPromise(harness.run(step(), host).pipe(Stream.runDrain))

    const system = engine.recorder.sealStep[0]?.request.system.map((part) => part.text).join("\n") ?? ""
    expect(system).toContain("alpha")
    expect(system).not.toContain("private-beta")
  })

  it("keeps hidden flows out of elaboration as well as prompt disclosure", async () => {
    const hiddenCall: Step = {
      events: [
        ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "hidden", name: "private-beta" }),
        ModelEvent.ModelEvent.ToolCallDelta({
          type: "tool-call-delta",
          id: "hidden",
          arguments: "{}"
        }),
        ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "hidden" }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" })
      ]
    }
    const model = makeModel([hiddenCall, stopNoTools])
    const engine = makeEngine(model.model)
    const harness = await Effect.runPromise(
      makeHarness(
        model,
        engine,
        [descriptor("alpha"), descriptor("private-beta")],
        {
          visibility: [
            Visibility.make({
              name: "sdk:model",
              rules: [
                new Visibility.Rule({ effect: "allow", pattern: "*" }),
                new Visibility.Rule({ effect: "deny", pattern: "private-*" })
              ]
            })
          ]
        }
      )
    )

    await Effect.runPromise(harness.run(step(), host).pipe(Stream.runDrain))

    expect(engine.recorder.splice).toEqual([])
    expect(engine.recorder.sealStep[1]?.request.messages).toContainEqual(
      ModelRequest.Message.tool(
        ModelRequest.ToolResultPart.make({
          toolCallId: "hidden",
          content: "Unknown tool private-beta; re-issue the call."
        })
      )
    )
  })

  it("supplies recorded envelope, environment, and self-documentation declarations", async () => {
    const declared = new AgentStep.AgentStep({
      ...step(),
      envelope: new AgentStep.TextDeclaration({ text: "May read src/**.", digest: "envelope" }),
      environment: new AgentStep.TextDeclaration({
        text: "cwd=/workspace; date=2026-07-28; platform=linux",
        digest: "environment"
      }),
      selfDocumentation: new AgentStep.TextDeclaration({
        text: "docs/reference/harness.md",
        digest: "self-documentation"
      })
    })
    const model = makeModel([stopNoTools])
    const engine = makeEngine(model.model)
    const harness = await Effect.runPromise(makeHarness(model, engine))

    await Effect.runPromise(harness.run(declared, host).pipe(Stream.runDrain))

    const system = engine.recorder.sealStep[0]?.request.system.map((part) => part.text).join("\n") ?? ""
    expect(system).toContain("May read src/**.")
    expect(system).toContain("cwd=/workspace; date=2026-07-28; platform=linux")
    expect(system).toContain("docs/reference/harness.md")
  })

  it("assembles the first request from the recorded journal prefix", async () => {
    const recordedMessage = ModelRequest.Message.assistant("recorded", { stopReason: "stop" })
    const recordedStep = new AgentStep.AgentStep({
      ...step(),
      journal: [
        entry(
          1,
          "flows.harness.model-settled.v1",
          new AgentEvent.ModelSettled({
            eventType: "flows.harness.model-settled.v1",
            message: recordedMessage,
            usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
          })
        )
      ]
    })
    const model = makeModel([stopNoTools])
    const engine = makeEngine(model.model)
    const harness = await Effect.runPromise(makeHarness(model, engine))

    await Effect.runPromise(harness.run(recordedStep, host).pipe(Stream.runDrain))

    expect(engine.recorder.sealStep[0]?.request.messages).toContainEqual(recordedMessage)
  })

  it("carries resume state outside key material and reports the poison pill", async () => {
    const plainModel = makeModel([stopNoTools])
    const plainEngine = makeEngine(plainModel.model)
    const plainHarness = await Effect.runPromise(makeHarness(plainModel, plainEngine))
    await Effect.runPromise(plainHarness.run(step(), host).pipe(Stream.runDrain))

    const resumedModel = makeModel([stopNoTools])
    const resumedEngine = makeEngine(resumedModel.model)
    const resumedHarness = await Effect.runPromise(
      makeHarness(
        resumedModel,
        resumedEngine,
        [descriptor("alpha")],
        {
          resume: new LegacyHarness.ResumeState({
            agentEngine: "sdk",
            agentResume: "session-1",
            discardResumeSession: true
          })
        }
      )
    )
    const events = await Effect.runPromise(
      resumedHarness.run(step(), host).pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items))
      )
    )
    const resume = events[0]

    expect(resume?._tag).toBe("resume-token")
    expect(resume?._tag === "resume-token" && resume.discardResumeSession).toBe(true)
    expect(resumedEngine.recorder.sealStep[0]?.keyMaterial.inputs).toEqual(
      plainEngine.recorder.sealStep[0]?.keyMaterial.inputs
    )
  })

  it("turn cancellation yields well-formed aborted results as values", async () => {
    const model = makeModel([twoCalls])
    const engine = makeEngine(model.model, [
      {
        _tag: "Interrupt",
        startedChildren: 1
      }
    ])
    const harness = await Effect.runPromise(
      makeHarness(model, engine, [
        descriptor("alpha"),
        descriptor("beta")
      ])
    )
    const observed: Array<AgentEvent.AgentEvent> = []
    const exit = await Effect.runPromise(interrupt(harness, observed))
    const results = observed.filter(
      (event): event is AgentEvent.ChildResult => event._tag === "child-result"
    )

    expect(engine.recorder.splice[0]).not.toHaveProperty("mode")
    expect(engine.recorder.startedCallIds).toEqual(["a"])
    expect(engine.recorder.abortedCallIds).toEqual(["a"])
    expect(results.map((event) => [
      event.result.callId,
      event.result.outcome,
      event.result.result.toolCallId
    ])).toEqual([
      ["a", "aborted", "a"],
      ["b", "aborted", "b"]
    ])
    expect(observed.some((event) => event._tag === "aborted")).toBe(true)
    expect(errorFrom(exit)?.code).toBe("aborted")
  })

  it("reports a missing sibling result without inventing source-order sequencing", async () => {
    const model = makeModel([twoCalls])
    const engine = makeEngine(model.model, [
      {
        _tag: "Results",
        results: [childResult("a", "Operation aborted", "aborted")]
      }
    ])
    const harness = await Effect.runPromise(
      makeHarness(model, engine, [
        descriptor("alpha"),
        descriptor("beta")
      ])
    )
    const observed: Array<AgentEvent.AgentEvent> = []
    const exit = await Effect.runPromise(interrupt(harness, observed))
    const results = observed.filter(
      (event): event is AgentEvent.ChildResult => event._tag === "child-result"
    )

    expect(engine.recorder.splice[0]).not.toHaveProperty("mode")
    expect(results.map((event) => [event.result.callId, event.result.outcome])).toEqual([
      ["a", "aborted"],
      ["b", "error"]
    ])
    expect(errorFrom(exit)?.code).toBe("aborted")
  })

  it("re-runs the whole sealed step after interruption before settlement", async () => {
    const model = makeModel([midStreamInterrupt, stopNoTools])
    const engine = makeEngine(model.model)
    const harness = await Effect.runPromise(makeHarness(model, engine))
    const observed: Array<AgentEvent.AgentEvent> = []
    const firstExit = await Effect.runPromise(interrupt(harness, observed))
    const secondEvents = await Effect.runPromise(
      harness.run(step(), host).pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items))
      )
    )

    expect(errorFrom(firstExit)?.code).toBe("aborted")
    // The interrupted attempt still observed text, so it settles a partial,
    // metadata-free assistant message. That partial is *observation only*: it
    // seals nothing, which is why the second attempt below re-runs the whole
    // step under identical key material.
    const partial = observed.find((event): event is AgentEvent.ModelSettled => event._tag === "model-settled")
    expect(partial?.message).toMatchObject({
      content: [{ type: "text", text: "partial" }],
      stopReason: "aborted"
    })
    expect(partial?.message.responseId).toBeUndefined()
    expect(partial?.message.itemIds).toBeUndefined()
    expect(observed.some((event) => event._tag === "aborted")).toBe(true)
    expect(secondEvents.at(-1)?._tag).toBe("resolved")
    expect(engine.recorder.sealStep).toHaveLength(2)
    expect(engine.recorder.sealStep[0]?.keyMaterial.inputs).toEqual(
      engine.recorder.sealStep[1]?.keyMaterial.inputs
    )
  })

  it("keeps the package root platform-neutral", () => {
    expect(Public.Harness).toBeDefined()
    expect(Public.Turn).toBeDefined()
    expect(Schema.decodeUnknownSync(AgentStep.AgentStep)(step())).toEqual(step())
  })
})
