/**
 * Pi §7 and OpenCode stream parity:
 * `docs/specs/Research/Pi Reference Findings 2026-07-27.md`.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { ModelRequest } from "@smthrs/model"
import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Elaborate from "../src/Elaborate.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Plan from "../src/Plan.ts"
import * as Steering from "../src/Steering.ts"
import * as Turn from "../src/Turn.ts"
import { final, interleaved, make, makeBuffered } from "./fixtures/streamingModel.ts"

const alpha = ModelRequest.ToolDefinition.make({ name: "alpha", description: "alpha", parameters: {} })

const run = async (slow = false, buffered = false) => {
  const model = buffered ? makeBuffered([interleaved, final]) : make([interleaved, final])
  const transportCompleteAtConsumption: Array<boolean> = []
  const engine = EngineLike.make({
    sealStep: ({ request }) => model.model.stream(request),
    splice: (batch) =>
      Stream.concat(
        Stream.fromIterable(interleaved.progress).pipe(
          Stream.tap((update) =>
            Effect.sync(() => {
              model.recorder.progress.push(update)
            })
          ),
          Stream.map((update) => new Plan.ChildProgress(update))
        ),
        Stream.fromIterable(
          batch.children.flatMap((child): ReadonlyArray<Plan.SpliceEvent> => [
            new Plan.ChildSettled({
              result: new Plan.ChildResult({
                callId: child.callId,
                outcome: "success",
                result: ModelRequest.ToolResultPart.make({ toolCallId: child.callId, content: "done" })
              })
            }),
            new Plan.ChildProgress({ callId: child.callId, message: "late" }),
            new Plan.ChildSettled({
              result: new Plan.ChildResult({
                callId: child.callId,
                outcome: "success",
                result: ModelRequest.ToolResultPart.make({ toolCallId: child.callId, content: "duplicate" })
              })
            })
          ])
        )
      ),
    call: () => Effect.die("this fixture drives the tool-call path, not cells"),
    record: (boundary) => boundary.execute,
    suspend: () => Effect.die("unexpected suspension")
  })
  const context = ContextWindow.make({
    modelId: "model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "system" })] },
      { kind: "tools", zone: "prefix", content: [alpha] },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
    ],
    activeTools: ["alpha"]
  })
  const catalog: Elaborate.Catalog = {
    tools: {
      alpha: {
        flowName: "alpha",
        input: Schema.Struct({ value: Schema.String }),
        capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none()
      }
    }
  }
  const events: Array<AgentEvent.AgentEvent> = []
  await Effect.runPromise(
    Turn.run({
      state: Turn.make({
        seat: "fixture:model",
        modelParams: ModelRequest.GenerationParams.make(),
        layers: [],
        capabilityEnvelope: [],
        placement: Option.none(),
        contextWindow: context
      }),
      catalog
    }).pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          events.push(event)
        }).pipe(
          Effect.andThen(slow ? Effect.sleep(1) : Effect.void),
          Effect.andThen(
            Effect.sync(() => {
              transportCompleteAtConsumption.push(model.recorder.transportComplete)
            })
          )
        )
      ),
      Stream.runDrain,
      Effect.provide(EngineLike.layer(engine)),
      Effect.provide(Steering.layerNoop())
    )
  )
  return { events, model, transportCompleteAtConsumption }
}

describe("streaming layers", () => {
  it("publishes interleaved transcript deltas before settlement and preserves their fixture order", async () => {
    const first = await run()
    const second = await run()
    const deltaTypes = first.events.filter((event) => event._tag === "model-delta").map((event) => event.delta.type)

    expect(deltaTypes).toEqual([
      "text-start",
      "thinking-start",
      "text-start",
      "text-delta",
      "thinking-delta",
      "text-delta",
      "tool-call-start",
      "tool-call-delta",
      "text-delta",
      "tool-call-delta",
      "text-delta",
      "thinking-end",
      "tool-call-end",
      "text-end",
      "text-end",
      "text-start",
      "text-delta",
      "text-end"
    ])
    expect(
      first.events
        .find((event): event is AgentEvent.ModelSettled => event._tag === "model-settled")
        ?.message.content.filter((part) => part.type === "text")
    ).toEqual([
      { type: "text", text: "I will call alpha" },
      { type: "text", text: "Then record the result" }
    ])
    expect(first.events.findIndex((event) => event._tag === "model-settled")).toBeGreaterThan(
      first.events.findIndex((event) => event._tag === "model-delta")
    )
    expect(first.events.map((event) => event._tag)).toEqual(second.events.map((event) => event._tag))
  })

  it("keeps tool progress scoped to execution and does not lose or reorder deltas for a slow consumer", async () => {
    const fast = await run()
    const slow = await run(true, true)

    expect(
      fast.events.filter((event) => event._tag === "child-progress").map((event) => event.progress.message)
    ).toEqual(["started", "finished"])
    expect(
      slow.events.filter((event) => event._tag === "child-progress").map((event) => event.progress.message)
    ).toEqual(["started", "finished"])
    expect(
      slow.events.find((event) => event._tag === "child-result")?.result.result.content
    ).toBe("done")
    expect(slow.events.filter((event) => event._tag === "model-delta").map((event) => event.delta)).toEqual(
      fast.events.filter((event) => event._tag === "model-delta").map((event) => event.delta)
    )
    expect(slow.events.at(-1)?._tag).toBe("resolved")
    expect(
      slow.events.some(
        (event, index) => event._tag === "model-delta" && slow.transportCompleteAtConsumption[index] === true
      )
    ).toBe(true)
    expect(slow.model.recorder.transportComplete).toBe(true)
  })
})
