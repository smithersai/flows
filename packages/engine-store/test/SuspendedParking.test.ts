/**
 * Pins issue #12: a run that actually suspends through the execution path
 * must park — populating `waiting_reason`/`waiting_wake_at_ms` so
 * `waitingRuns` sweepers can find it — and a resume must wake it.
 */
import { DurableClock, DurableDeferred, Flow, type FlowEngine } from "@smithers/engine"
import { RunStore, TestJournal } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "parking-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const withEngine = <A>(
  state: DurableEngineState.Service,
  body: (
    makeEngine: Effect.Effect<
      unknown,
      never,
      any
    >,
    store: RunStore.Service
  ) => Effect.Effect<A, any, any>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const makeEngine = EngineStore.make({
          owner: { hostId: "parking-host" },
          journalSource: "parking-test",
          isAlive: () => Effect.succeed(false)
        })
        return yield* body(makeEngine as never, store)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestJournal.layer())
    ) as Effect.Effect<A>
  )

describe("suspended runs park with a waiting reason", () => {
  it("a flow suspending on a deferred parks with reason 'event' and wakes on resume", async () => {
    const EventFlow = Flow.make("Parking/Event", {
      payload: {},
      success: Schema.String
    })
    const gate = DurableDeferred.make("parking-gate", { success: Schema.String })
    const handler = () => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)
    const state = DurableEngineState.makeMemory()

    const result = await withEngine(state, (makeEngine, store) =>
      Effect.gen(function*() {
        const engine = (yield* makeEngine) as FlowEngine.FlowEngine["Service"]
        yield* engine.register(EventFlow as never, handler as never)
        yield* engine.execute(EventFlow as never, {
          executionId: "parking-event",
          payload: {},
          discard: true
        })
        const suspendedRow = yield* store.get("parking-event")
        const parked = yield* state.waiting("parking-event")
        const sweep = yield* state.waitingRuns({ reason: "event" })

        yield* engine.deferredDone(gate as never, {
          flowName: EventFlow._tag,
          executionId: "parking-event",
          deferredName: gate.name,
          exit: Exit.succeed("open")
        })
        yield* engine.execute(EventFlow as never, {
          executionId: "parking-event",
          payload: {},
          discard: true
        })
        const completedRow = yield* store.get("parking-event")
        const afterResume = yield* state.waiting("parking-event")
        return { suspendedRow, parked, sweep, completedRow, afterResume }
      }))

    expect(result.suspendedRow.status).toBe("suspended")
    expect(Option.getOrThrow(result.parked).reason).toBe("event")
    expect(result.sweep.map((row) => row.runId)).toContain("parking-event")
    expect(result.completedRow.status).toBe("completed")
    expect(Option.isNone(result.afterResume)).toBe(true)
  })

  it("a flow suspending on a durable clock parks with reason 'timer' and its wake deadline", async () => {
    const TimerFlow = Flow.make("Parking/Timer", {
      payload: {},
      success: Schema.String
    })
    const handler = () =>
      DurableClock.sleep({ name: "parking-timer", duration: "5 minutes" }).pipe(
        Effect.as("slept")
      )
    const state = DurableEngineState.makeMemory()

    const result = await withEngine(state, (makeEngine, store) =>
      Effect.gen(function*() {
        const engine = (yield* makeEngine) as FlowEngine.FlowEngine["Service"]
        yield* engine.register(TimerFlow as never, handler as never)
        yield* engine.execute(TimerFlow as never, {
          executionId: "parking-timer",
          payload: {},
          discard: true
        })
        const suspendedRow = yield* store.get("parking-timer")
        const parked = yield* state.waiting("parking-timer")
        const clocks = yield* state.dueClocks(Number.MAX_SAFE_INTEGER)
        return { suspendedRow, parked, clocks }
      }))

    expect(result.suspendedRow.status).toBe("suspended")
    const row = Option.getOrThrow(result.parked)
    expect(row.reason).toBe("timer")
    expect(row.wakeAt).toBe(
      result.clocks.find((clock) => clock.executionId === "parking-timer")!.dueAtMs
    )
  })
})
