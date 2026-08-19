/**
 * A model-backed step declared the way a workflow author declares one, run as
 * a step inside an ordinary flow.
 *
 * Everything under the declaration is production: the real durable engine, the
 * real QuickJS sandbox, the real cell controller, the real registry-backed call
 * bridge. Only the provider is scripted, which is what makes the test
 * deterministic and CI-safe — there is no API key anywhere in it.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/**
 * A model that answers with one scripted cell per call and records the prompt
 * it was given, so the test can assert what the schema teaching contained.
 */
const scripted = (cells: ReadonlyArray<string>, requests: Array<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") + "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
        const source = cells[index] ?? cells.at(-1)!
        index++
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

/** A cell that completes immediately with a literal answer. */
const answering = (output: string): string =>
  `return { intent: "complete", state: {}, output: ${JSON.stringify(output)} }`

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const host: AgentAction.Host = {
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 3
}

/** The other half of the seam: a scripted model behind the host's resolver. */
const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) => Effect.succeed(Seat.make({ id, model, route, contextWindowTokens: 200_000 }))
  })

const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

const Reviewer = AgentAction.make("agent/test/Reviewer", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  system: ["You review diffs."],
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const ReviewFlow = Flow.make("agent/test/ReviewFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Reviewer.call({ diff })
})

/** A step whose frame budget runs out before the cell ever completes. */
const Staller = AgentAction.make("agent/test/Staller", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  maxFrames: 1
})

const Stalling = Flow.make("agent/test/Stalling", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Staller.call({ diff })
})

const run = (
  cells: ReadonlyArray<string>,
  requests: Array<string>,
  executionId: string
) =>
  ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId }).pipe(
    Effect.provide(
      Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
        Layer.provideMerge(AgentAction.layerHost(host)),
        Layer.provideMerge(seats(scripted(cells, requests))),
        Layer.provideMerge(Layer.merge(Agent.layer, Agent.layerDefaults)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
  )

describe("AgentAction.make", () => {
  it("runs the cell loop as one step and yields the schema-typed answer", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      run([answering(`{"approved":true,"issues":[]}`)], requests, "review-1")
    )

    expect(result).toEqual({ approved: true, issues: [] })

    // The declaration's own teaching and the rendered output schema both
    // reached the provider, and so did the prompt built from the payload.
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("You review diffs.")
    expect(requests[0]).toContain("Required output shape")
    expect(requests[0]).toContain("\"approved\"")
    expect(requests[0]).toContain("Review this diff:")
  })

  it("extracts the answer from prose around it rather than demanding a bare document", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      run(
        [answering(`Here is my review:\n\n{"approved":false,"issues":["missing test"]}\n\nHope that helps.`)],
        requests,
        "review-2"
      )
    )

    expect(result).toEqual({ approved: false, issues: ["missing test"] })
    expect(requests).toHaveLength(1)
  })

  it("spends one correction slot re-prompting a decode miss, then succeeds", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      run(
        [
          answering("Looks fine to me."),
          answering(`{"approved":true,"issues":[]}`)
        ],
        requests,
        "review-3"
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    expect(requests).toHaveLength(2)
    // The correction restates the task and adds the diagnostics; it never
    // reinterprets the step.
    expect(requests[1]).toContain("Review this diff:")
    expect(requests[1]).toContain("did not validate")
  })

  it("fails typed when the run ends without a completed answer", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        Stalling.execute({ diff: "-  old\n+  new" }, { executionId: "review-5" }).pipe(
          Effect.provide(
            Layer.mergeAll(Staller.layer, Interpreter.layer(Stalling)).pipe(
              Layer.provideMerge(AgentAction.layerHost(host)),
              Layer.provideMerge(
                seats(scripted(["return { intent: \"continue\", state: {}, context: [] }"], requests))
              ),
              Layer.provideMerge(Layer.merge(Agent.layer, Agent.layerDefaults)),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit._tag === "Failure" ? exit.cause : undefined)).toContain(
      "ended without a completed answer"
    )
  })

  it("fails typed when the correction budget is exhausted", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(run([answering("Looks fine to me.")], requests, "review-4"))
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? exit.cause : undefined
    const rendered = JSON.stringify(failure)
    expect(rendered).toContain("StructuredOutputFailure")
    // One first attempt plus one correction, and no third call.
    expect(requests).toHaveLength(2)
  })
})
