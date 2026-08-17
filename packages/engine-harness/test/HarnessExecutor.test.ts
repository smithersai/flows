/**
 * The composition root, end to end: control → executor → durable engine.
 *
 * One scenario carries the definition of done. A planned agent flow is
 * approved and run through the real `Control` service; the production
 * executor accepts the launch and executes the cell loop on the real durable
 * engine; frame zero makes a tool call through the real QuickJS sandbox; an
 * operator steer admitted through `Control.steer` is delivered at the frame
 * boundary; frame one's `ask` parks the run as `waiting-approval`, is
 * approved through `Control.approve` with the exact payload the executor
 * journaled, and the resumed run replays its settled prefix and completes.
 *
 * The scenario runs twice: once against a scripted model that records every
 * provider request, and once against `RecordedModel` replaying that fixture —
 * which proves the composition is deterministic enough to be driven entirely
 * from a recording, and that the recording is consumed in full.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Control, ControlError, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as CoreFlow from "@smthrs/core/Flow"
import * as StepBoundary from "@smthrs/engine-store-next/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store-next/WorkspaceSandbox"
import * as NodeRuntime from "@smthrs/flows-next/NodeRuntime"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import type * as Fixture from "@smthrs/testing/Fixture"
import type * as ModelLike from "@smthrs/testing/ModelLike"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import { Cause, Deferred, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as HarnessExecutor from "../src/HarnessExecutor.ts"

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

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/notes",
  description: "The notes agent.",
  body: new Descriptor.BodyRefMarkdown({ path: "/flows/agents/notes/flow.md", baseDirectory: "/flows/agents/notes" }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/notes",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

const moduleDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/module",
  body: new Descriptor.BodyRefModule({ path: "/flows/agents/module/flow.ts" }),
  path: "/flows/agents/module"
})

const descriptors = new Map([
  [agentDescriptor.name, agentDescriptor],
  [moduleDescriptor.name, moduleDescriptor]
])

const registryService = Registry.makeNoop({
  list: () => Effect.succeed([agentDescriptor, moduleDescriptor]),
  visible: () => Effect.succeed([]),
  get: (name) =>
    descriptors.has(name)
      ? Effect.succeed(descriptors.get(name)!)
      : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
  getOption: (name) => Effect.succeed(Option.fromNullishOr(descriptors.get(name))),
  loadBody: (name) =>
    Effect.succeed(
      name === moduleDescriptor.name
        ? new Descriptor.FlowBodyModule({ path: "/flows/agents/module/flow.ts" })
        : new Descriptor.FlowBodyPrompt({ text: "Keep the note log tidy.", baseDirectory: "/flows/agents/notes" })
    )
})

const memoryFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/notes",
    description: "The notes agent.",
    deployClass: false,
    // One valid wildcard, one valid exact pattern, and three malformed
    // entries the composition must drop rather than widen: no resource, a
    // pattern-less name, and an action outside the vocabulary.
    envelope: {
      capabilities: ["*:**", "fs:read:**", "fs:read", "single", "zz:yy:**"],
      flows: [],
      budget: {}
    }
  },
  {
    flowId: "agents/module",
    description: "An agent seat over a module body, which the harness refuses.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  },
  {
    flowId: "system/idle",
    description: "A flow no executor composition can run.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  }
]

const noteFlow = CoreFlow.make({
  name: "note/save",
  description: "Save one line to the run's note log.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

const frameZero = `const saved = await ctx.call("note/save", { text: "frame zero note" })
return { intent: "continue", state: { saved: saved.saved }, context: [{ role: "user", text: "note saved" }] }`

const frameOne = `const decision = await ctx.call("ask", { question: "publish the log?", options: ["yes", "no"] })
return { intent: "complete", state: null, output: "approved=" + decision.approved }`

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

interface Captured {
  readonly request: ModelRequest.ModelRequest
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
}

/** A scripted model that records the exact provider request of every frame. */
const capturing = (captured: Array<Captured>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const source = captured.length === 0 ? frameZero : frameOne
        const events = cellEvents(source, `cell-${captured.length}`)
        captured.push({ request, events })
        return Stream.fromIterable(events)
      })
  })

const principal: ControlSchema.Principal = { id: "operator", kind: "test", stampedAt: 1 }

const steerBody = "steer: mention the weather"

interface StackOptions {
  readonly resolveSeat: HarnessExecutor.Options["resolveSeat"]
  readonly notes: Array<string>
  readonly gate: Deferred.Deferred<void>
  /** Completes when the test tool enters its gate, before its side effect. */
  readonly toolStarted?: Deferred.Deferred<void> | undefined
  /** Omit the host flow sources entirely, exercising the executor's default. */
  readonly bare?: boolean | undefined
}

/**
 * The full production stack: the live control plane, the real executor, and
 * the SQLite-backed durable engine composed by `flows/NodeRuntime`. The
 * control test journal remains deterministic, while the executor-facing flow
 * runtime uses the same production storage and startup ordering as NodeControl.
 */
const stack = (options: StackOptions) => {
  const root = mkdtempSync(join(tmpdir(), "flows-harness-executor-"))
  engineRoots.add(root)
  const journal = TestJournal.layer()
  const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
  const runtime = ControlRuntime.layerMemory({ flows: memoryFlows }).pipe(Layer.provide(NodeCrypto.layer))
  const registry = Layer.succeed(Registry.Registry)(registryService)
  const noteSource = FlowBinding.source("test/notes", [
    FlowBinding.make({
      flow: noteFlow,
      handler: (input) =>
        (options.toolStarted === undefined ? Effect.void : Deferred.succeed(options.toolStarted, void 0)).pipe(
          Effect.andThen(Deferred.await(options.gate)),
          Effect.andThen(Effect.sync(() => {
            options.notes.push(input.text)
            return { saved: options.notes.length }
          }))
        )
    })
  ])
  const registration = HarnessExecutor.layer({
    resolveSeat: options.resolveSeat,
    flows: options.bare === true ? undefined : [noteSource],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4
  })
  let snapshot = 0
  const jj = Jj.layerNoop({
    snapshot: () => Effect.succeed({ changeId: `snapshot-${snapshot++}` }),
    restore: () => Effect.void,
    diff: () => Effect.succeed("")
  })
  const engine = NodeRuntime.layer(
    {
      filename: join(root, "engine.db"),
      owner: { hostId: "harness-executor-test" },
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(Layer.provide([NodeFileSystem.layer, NodeCrypto.layer, jj]))
  return ControlLive.layer.pipe(
    Layer.provideMerge(engine),
    Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry))
  )
}

const engineRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...engineRoots].map((root) => rm(root, { recursive: true, force: true })))
  engineRoots.clear()
})

const seat = (model: Model.Model): HarnessExecutor.Options["resolveSeat"] => () =>
  Effect.succeed({
    model,
    route,
    contextWindowTokens: HarnessExecutor.contextWindowTokensFor("test-model")
  })

const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 500
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) {
      return yield* Effect.die(`run ${runId} never reached ${status} (still ${run.status})`)
    }
    yield* Effect.sleep(Duration.millis(10))
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

interface Outcome {
  readonly runId: string
  readonly requestedQuestion: string
  readonly grantTokens: ReadonlyArray<string>
}

/**
 * Drives one complete run: plan → approve → run → steer → park on the ask →
 * approve the in-run request → resume → completed.
 *
 * The gate releases the frame-zero tool call only after the steer is
 * admitted, so the frame-boundary drain deterministically sees it.
 */
const drive = (
  gate: Deferred.Deferred<void>,
  decision: "approve" | "deny" = "approve"
): Effect.Effect<Outcome, unknown, Control.Control | ControlRuntime.ControlRuntime> =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const runtime = yield* ControlRuntime.ControlRuntime

    const card = yield* control.plan({ flowId: "agents/notes", input: { topic: "standups" } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:notes"
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die("expected an accepted run")
    }
    const runId = receipt.runId

    yield* control.steer({
      runId,
      message: { messageId: "steer-1", runId, body: steerBody, principal, createdAt: 1 },
      idempotencyKey: "steer:1"
    })
    yield* Deferred.succeed(gate, void 0)

    // Frame one's ask parks the run and journals the exact approval payload
    // an operator replays through `flows approve`.
    const requested = yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.approval.requested"),
      Stream.take(1),
      Stream.runCollect
    )
    const requestedPayload = requested[0]?.payload as {
      readonly question: string
      readonly payload: unknown
    }
    yield* awaitStatus(runtime, runId, "waiting-approval")

    const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(requestedPayload.payload)
    yield* decision === "approve" ? control.approve(approval) : control.deny(approval)
    yield* control.resume({ runId, idempotencyKey: "resume:1" })
    yield* awaitStatus(runtime, runId, "completed")

    const grants = yield* runtime.grants
    return {
      runId,
      requestedQuestion: requestedPayload.question,
      grantTokens: grants.map((grant) => grant.tokenId)
    }
  })

const textOf = (request: ModelRequest.ModelRequest): string =>
  request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

describe("HarnessExecutor", () => {
  it("waits through an accepted control row before driving the engine", async () => {
    let reads = 0
    await Effect.runPromise(
      HarnessExecutor.waitForRunning(
        () => Effect.sync(() => (reads++ === 0 ? "accepted" : "running")),
        "run-wait",
        1
      )
    )
    expect(reads).toBe(2)
  })

  it("waits for a parked execution publication before resuming it", async () => {
    let polls = 0
    const parked = await Effect.runPromise(
      HarnessExecutor.waitForParked(
        () => Effect.sync(() => (++polls === 1 ? Option.none() : Option.some({ _tag: "Suspended" }))),
        1
      )
    )
    expect(parked).toBe(true)
    expect(polls).toBe(2)
    await expect(Effect.runPromise(HarnessExecutor.waitForParked(() => Effect.succeed(Option.none()), 0)))
      .resolves.toBe(false)
  })

  it("keeps cancellation and registration failures contained at the executor boundary", async () => {
    await expect(Effect.runPromise(HarnessExecutor.preserveDriverInterrupt(() => Effect.fail("interrupted"))))
      .resolves.toBeUndefined()
    const failure = await Effect.runPromise(
      Effect.flip(HarnessExecutor.registerDriver(() => Effect.fail("missing run"), "run-registration"))
    )
    expect(failure).toMatchObject({
      runId: "run-registration",
      message: "The run driver could not be registered for cancellation",
      cause: "missing run"
    })
    await expect(Effect.runPromise(HarnessExecutor.settleDriverFailure(Cause.fail("engine failed"), "run-failed")))
      .resolves.toBeUndefined()
    const interrupted = await Effect.runPromiseExit(
      HarnessExecutor.settleDriverFailure(Cause.interrupt(1), "run-interrupted")
    )
    expect(interrupted._tag).toBe("Failure")
  })

  it("drives a 2-frame run through control → executor → engine, then replays it from the recorded fixture", {
    timeout: 30_000
  }, async () => {
    // Pass one: a scripted model records the exact request of every frame.
    const captured: Array<Captured> = []
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate).pipe(
          Effect.provide(stack({ resolveSeat: seat(capturing(captured)), notes, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    // Two frames, one provider call each: the resumed attempt replayed both
    // sealed steps instead of asking the provider again.
    expect(captured).toHaveLength(2)
    // The steer admitted through Control.steer reached frame one's context at
    // the frame boundary, alongside the cell's own continuation insert.
    const frameOneText = textOf(captured[1]!.request)
    expect(frameOneText).toContain("note saved")
    expect(frameOneText).toContain(steerBody)
    // The QuickJS-sandboxed tool call executed exactly once across the park
    // and its resumed attempt.
    expect(notes).toEqual(["frame zero note"])
    // The in-run approval was requested with the question the cell asked, and
    // approving it installed the grant the resumed ask read.
    expect(outcome.requestedQuestion).toBe("publish the log?")
    expect(outcome.grantTokens.some((token) => token.startsWith(`ask/${outcome.runId}/`))).toBe(true)

    // Pass two: the same scenario, driven entirely from the recording.
    const fixture: Fixture.Fixture = {
      calls: captured.map((call) => ({
        request: call.request as unknown as ModelLike.ModelRequestLike,
        model: "test-model",
        events: call.events as unknown as ReadonlyArray<ModelLike.ModelEventLike>
      }))
    }
    const replayNotes: Array<string> = []
    const replayed = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const replay = yield* RecordedModel.make(fixture)
        const model = Model.make({ stream: replay.model.stream as Model.Model["stream"] })
        const driven = yield* drive(gate).pipe(
          Effect.provide(stack({ resolveSeat: seat(model), notes: replayNotes, gate }))
        )
        const unconsumed = yield* replay.controller.unconsumed()
        return { driven, unconsumed }
      }).pipe(Effect.scoped) as Effect.Effect<{
        driven: Outcome
        unconsumed: ReadonlyArray<Fixture.RecordedCall>
      }>
    )

    expect(replayNotes).toEqual(["frame zero note"])
    expect(replayed.driven.requestedQuestion).toBe("publish the log?")
    // Every recorded call was matched and consumed: the recording drove the
    // whole loop, nothing was unscripted and nothing was left over.
    expect(replayed.unconsumed).toEqual([])
  })

  it("accepts nothing it cannot execute: a flow without an agent body stays pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "system/idle", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:idle"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const events = yield* control.watch({ runId: receipt.runId }).pipe(
            Stream.take(2),
            Stream.runCollect
          )
          const run = yield* runtime.getRun(receipt.runId)
          return { kinds: events.map((event) => event.kind), status: run.status }
        }).pipe(Effect.provide(stack({ resolveSeat: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<{ kinds: ReadonlyArray<string>; status: string }, unknown>
    )

    expect(result.kinds).toEqual(["control.run.accepted", "control.run.pending"])
    expect(result.status).toBe("accepted")
  })

  it("delivers a denial to the resumed ask instead of parking forever", async () => {
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate, "deny").pipe(
          Effect.provide(stack({ resolveSeat: seat(capturing([])), notes, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    // The denial resolved the token without installing a grant, so the
    // resumed ask answered `denied` and the run still completed.
    expect(outcome.grantTokens.some((token) => token.startsWith("ask/"))).toBe(false)
    expect(notes).toEqual(["frame zero note"])
  })

  it("durably cancels a driver blocked in a tool before its side effect runs", async () => {
    const notes: Array<string> = []
    const status = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const toolStarted = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:cancelled-tool"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          // Wait until the first cell has entered `note/save`'s gate. This
          // makes the driver interruption deterministic rather than racing
          // the executor's asynchronous launch.
          yield* Deferred.await(toolStarted)
          // Cancelling must reach the durable engine, not merely change the
          // control row.
          yield* control.cancel({ runId: receipt.runId, idempotencyKey: "cancel:blocked-tool" })
          yield* Deferred.succeed(gate, void 0)
          yield* Effect.sleep(Duration.millis(20))
          return (yield* runtime.getRun(receipt.runId)).status
        }).pipe(Effect.provide(stack({ resolveSeat: seat(capturing([])), notes, gate, toolStarted })))
      }).pipe(Effect.scoped) as Effect.Effect<string>
    )

    expect(status).toBe("cancelled")
    expect(notes).toEqual([])
  })

  it("leaves a seated flow with a module body pending: only prompt flows run on the cell harness", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/module", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:module"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const run = yield* runtime.getRun(receipt.runId)
          return run.status
        }).pipe(Effect.provide(stack({ resolveSeat: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<string, unknown>
    )

    expect(result).toBe("accepted")
  })

  it("writes a failed status when the model errors, for an empty and an absent input", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        const failing = Model.make({
          stream: () => Stream.fail(new ModelError.ModelError({ code: "provider_internal", message: "boom" }))
        })
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const results: Array<string> = []
          // One empty-object input and one null input: both render the bare
          // prompt, and both runs settle as failed when the provider errors.
          for (const input of [{}, null]) {
            const card = yield* control.plan({ flowId: "agents/notes", input })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `run:failing:${card.planId}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected an accepted run")
            }
            yield* awaitStatus(runtime, receipt.runId, "failed")
            results.push((yield* runtime.getRun(receipt.runId)).status)
          }
          return results
        }).pipe(Effect.provide(stack({ resolveSeat: seat(failing), notes, gate, bare: true })))
      }).pipe(Effect.scoped) as Effect.Effect<ReadonlyArray<string>, unknown>
    )

    expect(statuses).toEqual(["failed", "failed"])
  })

  it("resolves a context window for every catalogued model and a floor for the rest", () => {
    expect(HarnessExecutor.contextWindowTokensFor("claude-sonnet-4-5")).toBe(200_000)
    expect(HarnessExecutor.contextWindowTokensFor("gpt-5")).toBe(400_000)
    expect(HarnessExecutor.contextWindowTokensFor("gpt-4.1-mini")).toBe(1_000_000)
    expect(HarnessExecutor.contextWindowTokensFor("gpt-4o")).toBe(128_000)
    expect(HarnessExecutor.contextWindowTokensFor("o3-mini")).toBe(200_000)
    // Never zero: zero is CellTurn's "compaction disabled".
    expect(HarnessExecutor.contextWindowTokensFor("somebody-elses-model")).toBe(128_000)
  })

  it("refuses a launch whose seat cannot be resolved", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        const resolveSeat: HarnessExecutor.Options["resolveSeat"] = (seatId) =>
          Effect.fail(new HarnessExecutor.SeatUnresolved({ seat: seatId, message: "No API key is configured" }))
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          return yield* Effect.flip(control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:unresolved"
          }))
        }).pipe(Effect.provide(stack({ resolveSeat, notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<unknown>
    )

    expect(error).toBeInstanceOf(ControlError.LaunchFailed)
    expect((error as ControlError.LaunchFailed).message).toBe("No API key is configured")
  })
})
