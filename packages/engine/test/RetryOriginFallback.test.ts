/**
 * Issue #69: pins the ternary's `Option.none()` arm when the durable retry
 * origin hook is present and the policy declares `expirationMs`. A missing
 * durable origin falls back to the current clock — the schedule-to-close
 * budget restarts (with a logged warning) instead of failing the run — so
 * the #45 fix cannot silently regress into an untested branch.
 */
import { Cause, Effect, Exit, Fiber, Layer, Logger, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine, RetryPolicy } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const flow = Flow.make("RetryOriginFallback/flow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  error: Schema.String
})

describe("retry origin fallback when the durable hook yields none", () => {
  effect("restarts the expiration budget from the current clock instead of expiring or dying", () => {
    const attempts: Array<number> = []
    const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
    const capture = Logger.make((options) => {
      logs.push({ message: options.message, logLevel: options.logLevel })
    })
    const activity = Activity.make({
      name: "RetryOriginFallback/pruned",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        expirationMs: 1
      }),
      execute: Effect.die("scripted driver dispatches instead")
    })
    let originRequests = 0
    const engine = FlowEngine.makeUnsafe({
      register: () => Effect.void,
      execute: () => Effect.die("not used"),
      poll: () => Effect.succeedNone,
      interrupt: () => Effect.void,
      interruptUnsafe: () => Effect.void,
      resume: () => Effect.void,
      activityExecute: (input) =>
        Effect.sync(() => {
          attempts.push(input.attempt)
          return new Flow.Complete({ exit: Exit.fail("still-failing") })
        }),
      // Every attempt row was pruned: the durable driver has no origin.
      activityRetryOrigin: () => Effect.sync(() => (originRequests++, Option.none())),
      deferredResult: () => Effect.succeedNone,
      deferredDone: () => Effect.void,
      scheduleClock: () => Effect.void
    })
    return Effect.gen(function*() {
      const fiber = yield* engine.activityExecute(activity, 1).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      // Attempt 1 runs at elapsed 0 and schedules the 1ms backoff; the
      // adjusted clock spends the restarted window, so attempt 2 expires.
      yield* TestClock.adjust("1 millis")
      const result = yield* Fiber.join(fiber)
      expect(originRequests).toBe(1)
      // The budget restarted from the current clock: attempt 1 got its full
      // window (a durable origin of 0 would have expired it immediately with
      // a single dispatch), and the sequence expired only once the restarted
      // 1ms window elapsed across the backoff sleep.
      expect(attempts).toEqual([1, 2])
      // The restarted budget must be observable (issue #82): the fallback's
      // only operator signal is the warning naming the activity, emitted
      // exactly once for the retry sequence — not once per attempt.
      const warnings = logs.filter((entry) =>
        entry.logLevel === "Warn" &&
        String(entry.message).includes("no durable retry origin") &&
        String(entry.message).includes("RetryOriginFallback/pruned")
      )
      expect(warnings.length).toBe(1)
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isFailure(result.exit)) {
          expect(Cause.squash(result.exit.cause)).toMatchObject({
            _tag: "@smthrs/engine/RetryPolicyExpired",
            activityName: "RetryOriginFallback/pruned",
            expirationMs: 1,
            lastError: "still-failing"
          })
        }
      }
    }).pipe(
      Effect.provideService(
        FlowEngine.FlowInstance,
        FlowEngine.FlowInstance.initial(flow, "retry-origin-fallback-run")
      ),
      Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(engine)),
      Effect.provide(Logger.layer([capture])),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<void>
  })
})
