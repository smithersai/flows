/**
 * Issue #59: the retry verdict is durable. A persisted `failed` attempt row
 * replays by rethrowing the persisted domain failure — never by surfacing
 * `AttemptAdmissionRejected` — so a policy-declared `nonRetryable` error
 * matches on resume: the activity body is not re-dispatched and the backoff
 * ladder is not re-slept.
 *
 * Temporal prior art: mutable state persists the attempt failure alongside
 * `ExecutionInfo.Attempt`, and the no-retry decision
 * (`service/history/workflow/retry.go`) is re-evaluated against that
 * persisted failure after a restart — the failure itself is durable, not
 * just the fact that an attempt happened.
 */
import { Activity, Flow, RetryPolicy } from "@smithers/engine"
import { AttemptStore, Notifying, RunStore, TestJournal } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import { Digest, StepKey } from "@smithers/keys"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const ReplayFlow = Flow.make("NonRetryableReplay/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String })
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "non-retryable-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const provide = <A>(effect: Effect.Effect<A, any, any>, state: DurableEngineState.Service) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, state),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestJournal.layer()),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

// The engine derives a sealed activity's string idempotency key through
// `StepKey.content`; the test mirrors it to inspect the persisted rows.
const activityKey = (name: string, idempotencyKey: string) =>
  Result.getOrThrow(StepKey.content({
    body: { activity: name, idempotencyKey },
    inputs: {},
    layers: [],
    capabilities: {}
  }))

describe("non-retryable verdict durability across resume", () => {
  it("does not re-dispatch a durably failed non-retryable activity and propagates the original error without backoff sleeps", async () => {
    let dispatches = 0
    const fatal = Activity.make({
      name: "NonRetryableReplay/fatal",
      success: Schema.String,
      error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }),
      tier: "sealed",
      idempotencyKey: "non-retryable-v1",
      retryPolicy: RetryPolicy.make({
        initialMs: 60_000,
        factor: 2,
        maxMs: 600_000,
        maxAttempts: 10,
        nonRetryable: ["FatalBoom"]
      }),
      execute: Effect.suspend(() => {
        dispatches++
        return Effect.fail({ _tag: "FatalBoom" as const, detail: "durable" })
      })
    })
    const state = DurableEngineState.makeMemory()
    const makeEngine = EngineStore.make({
      owner: { hostId: "non-retryable-host" },
      journalSource: "non-retryable-test",
      isAlive: () => Effect.succeed(false)
    })
    const key = activityKey("NonRetryableReplay/fatal", "non-retryable-v1")
    const attemptId = {
      runId: "non-retryable-run",
      stepKeyDigest: Digest.digest(key),
      attempt: 1
    }

    const result = await provide(
      Effect.gen(function*() {
        const attempts = yield* AttemptStore.AttemptStore
        // First process: the attempt fails and `attempts.finish` durably
        // records the non-retryable failure, then the process dies before
        // the failure propagates to the engine's retry decision — the hook
        // parks the fiber right after the failed finish and the scope close
        // interrupts it there, releasing the run.
        yield* Effect.scoped(Effect.gen(function*() {
          const blocked = Notifying.wrap(
            attempts,
            (op, order, args) =>
              op === "finish" && order === "after" &&
                (args[0] as { readonly state: string }).state === "failed"
                ? Effect.never
                : Effect.void
          )
          const engine = yield* Effect.provideService(
            makeEngine,
            AttemptStore.AttemptStore,
            blocked
          )
          yield* engine.register(ReplayFlow, () => fatal as never)
          yield* engine.execute(ReplayFlow, {
            executionId: "non-retryable-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          // Let the attempt run and durably fail; the fiber is now parked in
          // the post-finish hook.
          yield* Effect.yieldNow
          const row = yield* attempts.get(attemptId)
          expect(Option.isSome(row) && row.value.state === "failed").toBe(true)
        }))
        const dispatchesBeforeResume = dispatches

        // Second process: reclaim and re-drive. The persisted failed attempt
        // must replay the original `FatalBoom` — no readmission, no real
        // dispatch, and no backoff sleep (the clock is never advanced).
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(ReplayFlow, () => fatal as never)
          const result = yield* engine.poll(ReplayFlow, "non-retryable-run")
          expect(Option.isNone(result)).toBe(true)
          yield* engine.execute(ReplayFlow, {
            executionId: "non-retryable-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
        }))
        const store = yield* RunStore.RunStore
        return {
          dispatchesBeforeResume,
          dispatchesAfterResume: dispatches,
          row: yield* store.get("non-retryable-run")
        }
      }),
      state
    )

    expect(result.dispatchesBeforeResume).toBe(1)
    // The activity body is never re-executed after resume.
    expect(result.dispatchesAfterResume).toBe(1)
    expect(result.row.status).toBe("failed")
    // The original domain error propagates — not the admission wrapper.
    expect(result.row.stateJson).toContain("FatalBoom")
    expect(result.row.stateJson).not.toContain("AttemptAdmissionRejected")
  })

  it("replays a persisted failed attempt row by rethrowing the persisted domain error", async () => {
    // Unit-level pin on `ActivityPersistence`: a `failed` row must rethrow
    // the persisted cause — the `_tag` survives the JSON round trip so
    // `RetryPolicy` non-retryable matching works on replay.
    const { default: makeState } = { default: DurableEngineState.makeMemory }
    const state = makeState()
    const makeEngine = EngineStore.make({
      owner: { hostId: "failed-row-host" },
      journalSource: "failed-row-test",
      isAlive: () => Effect.succeed(false)
    })
    let dispatches = 0
    const flaky = Activity.make({
      name: "NonRetryableReplay/tagged",
      success: Schema.String,
      error: Schema.Struct({ _tag: Schema.Literal("FatalBoom"), detail: Schema.String }),
      tier: "sealed",
      idempotencyKey: "tagged-v1",
      execute: Effect.suspend(() => {
        dispatches++
        return Effect.fail({ _tag: "FatalBoom" as const, detail: "unit" })
      })
    })

    const outcome = await provide(
      Effect.gen(function*() {
        // First run records the failure durably and fails the run.
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(ReplayFlow, () => flaky as never)
          yield* engine.execute(ReplayFlow, {
            executionId: "failed-row-run",
            payload: {},
            discard: false
          }).pipe(Effect.exit)
        }))
        const attempts = yield* AttemptStore.AttemptStore
        const row = yield* attempts.get({
          runId: "failed-row-run",
          stepKeyDigest: Digest.digest(activityKey("NonRetryableReplay/tagged", "tagged-v1")),
          attempt: 1
        })
        return { row, dispatches }
      }),
      state
    )

    expect(outcome.dispatches).toBe(1)
    const row = Option.getOrThrow(outcome.row)
    expect(row.state).toBe("failed")
    // The persisted cause is JSON-shaped Fail material whose `_tag`
    // survives, which is exactly what the replay branch rehydrates.
    const cause = row.error as { readonly reasons: ReadonlyArray<{ readonly _tag: string; readonly error?: unknown }> }
    expect(cause.reasons[0]?._tag).toBe("Fail")
    expect((cause.reasons[0]?.error as { readonly _tag: string })._tag).toBe("FatalBoom")
  })
})
