/**
 * Pi §6 parity: `docs/specs/Research/Pi Reference Findings 2026-07-27.md`.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { ModelRequest } from "@smthrs/model"
import { Cause, Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Elaborate from "../src/Elaborate.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Plan from "../src/Plan.ts"
import * as Steering from "../src/Steering.ts"
import * as Turn from "../src/Turn.ts"
import { make, midStreamAbort, multiToolBatch } from "./fixtures/abortModel.ts"

const alpha = ModelRequest.ToolDefinition.make({ name: "alpha", description: "alpha", parameters: {} })
const beta = ModelRequest.ToolDefinition.make({ name: "beta", description: "beta", parameters: {} })

const catalog: Elaborate.Catalog = {
  tools: Object.fromEntries(["alpha", "beta"].map((name) => [name, {
    flowName: name,
    input: Schema.Struct({ value: Schema.String }),
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none()
  }]))
}

const state = () =>
  Turn.make({
    seat: "fixture:model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: ContextWindow.make({
      modelId: "model",
      segments: [
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "system" })] },
        { kind: "tools", zone: "prefix", content: [alpha, beta] },
        { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
      ],
      activeTools: ["alpha", "beta"]
    })
  })

describe("abort discipline", () => {
  it("preserves settled children, aborts only unsettled calls, and reports a typed abort", async () => {
    const model = make([multiToolBatch])
    const started: Array<string> = []
    const completed: Array<string> = []
    const engine = EngineLike.make({
      sealStep: ({ request }) => model.model.stream(request),
      splice: (batch) =>
        Stream.suspend(() => {
          const child = batch.children[0]
          if (child === undefined) return Stream.empty
          started.push(child.callId)
          completed.push(child.callId)
          return Stream.concat(
            Stream.succeed(
              new Plan.ChildSettled({
                result: new Plan.ChildResult({
                  callId: child.callId,
                  outcome: "success",
                  result: ModelRequest.ToolResultPart.make({ toolCallId: child.callId, content: "done" })
                })
              })
            ),
            Stream.fromEffect(Effect.interrupt)
          )
        }),
      call: () => Effect.die("this fixture drives the tool-call path, not cells"),
      record: (boundary) => boundary.execute,
      suspend: () => Effect.die("unexpected suspension")
    })
    const observed: Array<AgentEvent.AgentEvent> = []
    const exit = await Effect.runPromiseExit(
      Turn.run({ state: state(), catalog }).pipe(
        Stream.tap((event) => Effect.sync(() => observed.push(event))),
        Stream.runDrain,
        Effect.provide(EngineLike.layer(engine)),
        Effect.provide(Steering.layerNoop())
      )
    )

    expect(started).toEqual(["abort-a"])
    expect(completed).toEqual(["abort-a"])
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
    }
    const results = observed.filter((event): event is AgentEvent.ChildResult => event._tag === "child-result")
    expect(results.map((event) => [event.result.callId, event.result.outcome])).toEqual([
      ["abort-a", "success"],
      ["abort-b", "aborted"]
    ])
    expect(results.map((event) => event.result.result.content)).toEqual(["done", "Operation aborted"])
    expect(observed.map((event) => event._tag).slice(-2)).toEqual(["aborted", "turn-closed"])
    expect(observed.at(-1)).toMatchObject({ _tag: "turn-closed", outcome: "aborted" })
  })

  it("normalizes a mid-stream fiber interruption without an AbortSignal API", async () => {
    const model = make([midStreamAbort])
    const engine = EngineLike.make({
      sealStep: ({ request }) => model.model.stream(request),
      splice: () => Stream.fromEffect(Effect.die("a mid-stream abort must not splice")),
      call: () => Effect.die("this fixture drives the tool-call path, not cells"),
      record: (boundary) => boundary.execute,
      suspend: () => Effect.die("unexpected suspension")
    })
    const observed: Array<AgentEvent.AgentEvent> = []
    const exit = await Effect.runPromiseExit(
      Turn.run({ state: state(), catalog }).pipe(
        Stream.tap((event) => Effect.sync(() => observed.push(event))),
        Stream.runDrain,
        Effect.provide(EngineLike.layer(engine)),
        Effect.provide(Steering.layerNoop())
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(model.recorder.requests).toHaveLength(1)
    expect(model.recorder.events.map((event) => event.type)).toEqual(["text-start", "text-delta"])
    expect(observed.map((event) => event._tag)).toEqual([
      "turn-opened",
      "model-delta",
      "model-delta",
      "model-settled",
      "aborted",
      "turn-closed"
    ])
    const partial = observed.find((event): event is AgentEvent.ModelSettled => event._tag === "model-settled")
    expect(partial?.message).toMatchObject({
      content: [{ type: "text", text: "partial" }],
      stopReason: "aborted"
    })
    expect(partial?.message.responseId).toBeUndefined()
    expect(partial?.message.itemIds).toBeUndefined()
  })
})
