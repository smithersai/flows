import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #31: the production park path must be able to record `approval`
 * and `quota` waits (and the wake token), not only the derived
 * `timer`/`event` reasons. A flow declares its wait with
 * `FlowRuntime.annotateWaiting` immediately before suspending, and the driver
 * parks the run with exactly that payload so reason-specific sweeps
 * (`WHERE waiting_reason = 'approval'`) see it.
 */
import { Activity, DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow-next"
import { Jj } from "@smthrs/kernel-next"
import { Node } from "@smthrs/plan-next"
import { RunStore } from "@smthrs/run-store-next"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "annotated-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const withEngine = <A>(
  body: (
    engine: FlowRuntime.FlowRuntime["Service"],
    store: RunStore.Service,
    state: DurableEngineState.Service
  ) => Effect.Effect<A, any, any>
) => {
  const state = DurableEngineState.makeMemory()
  return runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engine = (yield* EngineStore.make({
          owner: { hostId: "annotated-host" },
          journalSource: "annotated-test",
          isAlive: () => Effect.succeed(false)
        })) as FlowRuntime.FlowRuntime["Service"]
        return yield* body(engine, store, state)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer())
    ) as Effect.Effect<A>
  )
}

describe("annotated waiting reasons reach the parked row (issue #31)", () => {
  it("a concurrent finishing dispatch cannot clobber a newer waiting declaration", async () => {
    const RaceFlow = Flow.make("Annotated/WaitingRace", {
      payload: {},
      success: Schema.Unknown,
      body: opaqueHandlerBody
    })
    const result = await withEngine((engine) =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const slow = Activity.make({
          name: "annotated-waiting-race-slow",
          success: Schema.Void,
          execute: Effect.gen(function*() {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })
        })
        const parked = Activity.make({
          name: "annotated-waiting-race-parked",
          success: Schema.Void,
          execute: FlowRuntime.annotateWaiting({ reason: "approval", token: "winner" })
        })
        yield* engine.register(
          RaceFlow as never,
          (() =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              const slowFiber = yield* slow.pipe(Effect.forkChild)
              yield* Deferred.await(entered)
              yield* parked
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(slowFiber)
              return instance.waiting
            })) as never
        )
        return yield* engine.execute(RaceFlow as never, {
          executionId: "annotated-waiting-race",
          payload: {}
        })
      })
    )

    expect(result).toEqual({ reason: "approval", token: "winner" })
  })

  it("a flow awaiting an approval parks as reason 'approval' with its token", async () => {
    const ApprovalFlow = Flow.make("Annotated/Approval", {
      payload: {},
      success: Schema.String,
      body: opaqueHandlerBody
    })
    const gate = DurableDeferred.make("annotated-approval-gate", { success: Schema.String })

    const result = await withEngine((engine, store, state) =>
      Effect.gen(function*() {
        yield* engine.register(
          ApprovalFlow as never,
          (() =>
            Effect.gen(function*() {
              yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "request-42" })
              return yield* Effect.map(DurableDeferred.await(gate), (value) => `approved:${value}`)
            })) as never
        )
        yield* engine.execute(ApprovalFlow as never, {
          executionId: "annotated-approval",
          payload: {},
          discard: true
        })
        const parked = yield* state.waiting("annotated-approval")
        const approvalSweep = yield* state.waitingRuns({ reason: "approval" })

        // Resolving the approval wakes the run and completes it normally.
        yield* engine.deferredDone(gate as never, {
          flowName: ApprovalFlow._tag,
          executionId: "annotated-approval",
          deferredName: gate.name,
          exit: Exit.succeed("yes")
        })
        yield* engine.execute(ApprovalFlow as never, {
          executionId: "annotated-approval",
          payload: {},
          discard: true
        })
        const finished = yield* store.get("annotated-approval")
        const afterWake = yield* state.waiting("annotated-approval")
        return { parked, approvalSweep, finished, afterWake }
      })
    )

    expect(Option.isSome(result.parked)).toBe(true)
    if (Option.isSome(result.parked)) {
      expect(result.parked.value.reason).toBe("approval")
      expect(result.parked.value.token).toBe("request-42")
    }
    expect(result.approvalSweep.map((row) => row.runId)).toEqual(["annotated-approval"])
    expect(result.finished.status).toBe("completed")
    expect(Option.isNone(result.afterWake)).toBe(true)
  })

  it("an activity's own declaration reaches the parked row, not the derived default", async () => {
    const GatedFlow = Flow.make("Annotated/ActivityGate", {
      payload: {},
      success: Schema.String,
      body: opaqueHandlerBody
    })
    const gate = DurableDeferred.make("annotated-activity-gate", { success: Schema.String })
    // The shape `WaitFor` ships: the wait is inside an ACTIVITY, so the
    // declaration is written on the dispatch's own instance. A driver that did
    // not thread it back would park this run on the derived `event` default and
    // drop the wake token the resolver is matched against.
    const waitPoint = Activity.make({
      name: "annotated-activity-wait",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "annotated-activity-wait-v1",
      execute: Effect.gen(function*() {
        yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "activity-token-7" })
        return yield* DurableDeferred.await(gate)
      })
    })

    const result = await withEngine((engine, store, state) =>
      Effect.gen(function*() {
        yield* engine.register(
          GatedFlow as never,
          (() => Effect.map(waitPoint, (value) => `approved:${value}`)) as never
        )
        yield* engine.execute(GatedFlow as never, {
          executionId: "annotated-activity",
          payload: {},
          discard: true
        })
        const parked = yield* state.waiting("annotated-activity")
        const approvalSweep = yield* state.waitingRuns({ reason: "approval" })

        yield* engine.deferredDone(gate as never, {
          flowName: GatedFlow._tag,
          executionId: "annotated-activity",
          deferredName: gate.name,
          exit: Exit.succeed("yes")
        })
        yield* engine.execute(GatedFlow as never, {
          executionId: "annotated-activity",
          payload: {},
          discard: true
        })
        const finished = yield* store.get("annotated-activity")
        const afterWake = yield* state.waiting("annotated-activity")
        return { parked, approvalSweep, finished, afterWake }
      })
    )

    const parked = Option.getOrThrow(result.parked)
    expect(parked.reason).toBe("approval")
    expect(parked.token).toBe("activity-token-7")
    expect(result.approvalSweep.map((row) => row.runId)).toEqual(["annotated-activity"])
    expect(result.finished.status).toBe("completed")
    // The resolved wait consumes the declaration on the way out, so nothing
    // stale survives the wake.
    expect(Option.isNone(result.afterWake)).toBe(true)
  })

  it("a quota wait parks with its wake deadline", async () => {
    const QuotaFlow = Flow.make("Annotated/Quota", {
      payload: {},
      success: Schema.String,
      body: opaqueHandlerBody
    })
    const gate = DurableDeferred.make("annotated-quota-gate", { success: Schema.String })

    const result = await withEngine((engine, _store, state) =>
      Effect.gen(function*() {
        yield* engine.register(
          QuotaFlow as never,
          (() =>
            Effect.gen(function*() {
              yield* FlowRuntime.annotateWaiting({ reason: "quota", wakeAt: 60_000 })
              return yield* Effect.map(DurableDeferred.await(gate), (value) => value)
            })) as never
        )
        yield* engine.execute(QuotaFlow as never, {
          executionId: "annotated-quota",
          payload: {},
          discard: true
        })
        return {
          due: yield* state.waitingRuns({ reason: "quota", dueBeforeMs: 100_000 })
        }
      })
    )

    expect(result.due).toEqual([
      { runId: "annotated-quota", reason: "quota", wakeAt: 60_000, token: null }
    ])
  })

  it("an annotation consumed by its resolved gate does not leak onto a later timer park (issue #42)", async () => {
    const TwoStageFlow = Flow.make("Annotated/TwoStage", {
      payload: {},
      success: Schema.String,
      body: opaqueHandlerBody
    })
    const gate = DurableDeferred.make("annotated-two-stage-gate", { success: Schema.String })

    const result = await withEngine((engine, store, state) =>
      Effect.gen(function*() {
        yield* engine.register(
          TwoStageFlow as never,
          (() =>
            Effect.gen(function*() {
              yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "request-42" })
              const approved = yield* DurableDeferred.await(gate)
              // The second suspension is timer-backed: the replayed approval
              // annotation must not classify this park.
              yield* DurableClock.sleep({
                name: "annotated-two-stage-timer",
                duration: "5 minutes",
                inMemoryThreshold: "1 second"
              })
              return `approved:${approved}`
            })) as never
        )
        yield* engine.execute(TwoStageFlow as never, {
          executionId: "annotated-two-stage",
          payload: {},
          discard: true
        })
        const firstPark = yield* state.waiting("annotated-two-stage")

        // Resolve the approval gate; the next drive replays the annotation,
        // passes through the resolved gate, and parks on the durable timer.
        yield* engine.deferredDone(gate as never, {
          flowName: TwoStageFlow._tag,
          executionId: "annotated-two-stage",
          deferredName: gate.name,
          exit: Exit.succeed("yes")
        })
        yield* engine.execute(TwoStageFlow as never, {
          executionId: "annotated-two-stage",
          payload: {},
          discard: true
        })
        const row = yield* store.get("annotated-two-stage")
        const secondPark = yield* state.waiting("annotated-two-stage")
        const timerSweep = yield* state.waitingRuns({ reason: "timer" })
        const approvalSweep = yield* state.waitingRuns({ reason: "approval" })
        return { firstPark, row, secondPark, timerSweep, approvalSweep }
      })
    )

    expect(Option.getOrThrow(result.firstPark).reason).toBe("approval")
    expect(result.row.status).toBe("suspended")
    const parked = Option.getOrThrow(result.secondPark)
    expect(parked.reason).toBe("timer")
    expect(typeof parked.wakeAt).toBe("number")
    expect(result.timerSweep.map((waiting) => waiting.runId)).toContain("annotated-two-stage")
    expect(result.approvalSweep).toEqual([])
  })
})
