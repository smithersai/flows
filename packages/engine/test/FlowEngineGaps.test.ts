import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Activity, DurableDeferred, Flow, FlowEngine, RetryPolicy } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>,
  predicate: (result: Flow.Result<A, E>) => boolean
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 100 && (Option.isNone(result) || !predicate(result.value)); i++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

const isSuspended = (result: Flow.Result<any, any>) => result._tag === "Suspended"

describe("boundary descriptor identity", () => {
  // `boundaryHermetic` only folds a *well-formed* descriptor into the content
  // key. Every malformed shape must be ignored — never partially applied and
  // never a crash — so two activities differing only in junk metadata keep the
  // same replay identity.
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["non-object metadata", "not-an-object"],
    ["null metadata", null],
    ["undefined metadata", undefined],
    ["readSet not an array", { readSet: {}, writeSet: [], boundaryMode: "hard" }],
    ["writeSet not an array", { readSet: [], writeSet: "out", boundaryMode: "hard" }],
    ["unknown boundaryMode", { readSet: [], writeSet: [], boundaryMode: "soft" }],
    ["missing boundaryMode", { readSet: [], writeSet: [] }],
    ["readSet entry not an object", { readSet: ["x"], writeSet: [], boundaryMode: "hard" }],
    ["readSet entry null", { readSet: [null], writeSet: [], boundaryMode: "hard" }],
    [
      "readSet entry without a string path",
      { readSet: [{ path: 1, digest: "d" }], writeSet: [], boundaryMode: "hard" }
    ],
    [
      "readSet entry without a string digest",
      { readSet: [{ path: "p", digest: 1 }], writeSet: [], boundaryMode: "hard" }
    ],
    [
      "writeSet entry not a string",
      { readSet: [], writeSet: [1], boundaryMode: "hard" }
    ]
  ]

  for (const [label, metadata] of malformed) {
    effect(`ignores ${label} and replays the descriptor-free identity`, () => {
      let executions = 0
      const plain = Activity.make({
        name: "Gaps/boundary",
        success: Schema.Number,
        idempotencyKey: "boundary/v1",
        execute: Effect.sync(() => ++executions)
      })
      const junk = Activity.make({
        name: "Gaps/boundary",
        success: Schema.Number,
        idempotencyKey: "boundary/v1",
        metadata: metadata as any,
        execute: Effect.sync(() => ++executions)
      })
      const flow = Flow.make("Gaps/boundary-malformed", {
        payload: { id: Schema.String },
        success: Schema.Number
      })
      const layer = flow.toLayer(() => Effect.andThen(plain, junk)).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )
      return Effect.gen(function*() {
        expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(1)
        expect(executions).toBe(1)
      }).pipe(Effect.provide(layer))
    })
  }

  effect("distinguishes the two well-formed boundary modes", () => {
    let executions = 0
    const build = (boundaryMode: "hard" | "expected") =>
      Activity.make({
        name: "Gaps/boundary-mode",
        success: Schema.Number,
        idempotencyKey: "mode/v1",
        metadata: { readSet: [], writeSet: [], boundaryMode },
        execute: Effect.sync(() => ++executions)
      })
    const flow = Flow.make("Gaps/boundary-modes", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* build("hard")
        yield* build("expected")
        return yield* build("hard")
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      // "hard" replays its own earlier result; "expected" is a distinct key
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(1)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("a well-formed descriptor only enters the key for sealed string identities", () => {
    // Ordinal-keyed (unsealed) activities never consult the descriptor.
    let executions = 0
    const build = (digest: string) =>
      Activity.make({
        name: "Gaps/unsealed-boundary",
        success: Schema.Number,
        metadata: {
          readSet: [{ path: "a", digest }],
          writeSet: ["out"],
          boundaryMode: "hard"
        },
        execute: Effect.sync(() => ++executions)
      })
    const flow = Flow.make("Gaps/unsealed-boundary", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() => Effect.andThen(build("d1"), build("d1"))).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      // both run: invocation key input advances regardless of the descriptor
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})

describe("annotateWaiting", () => {
  effect("records the declared waiting classification on the running instance", () => {
    const flow = Flow.make("Gaps/waiting", {
      payload: { id: Schema.String },
      success: Schema.Any
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const instance = yield* FlowEngine.FlowInstance
        const before = instance.waiting
        yield* FlowEngine.annotateWaiting({ reason: "approval", token: "req-1", wakeAt: 42 })
        const during = instance.waiting
        yield* FlowEngine.annotateWaiting(undefined)
        return { before, during, after: instance.waiting }
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const result = yield* flow.execute({ id: "x" }, { executionId: "run-waiting" })
      expect(result.before).toBeUndefined()
      expect(result.during).toEqual({ reason: "approval", token: "req-1", wakeAt: 42 })
      // clearing the annotation returns the instance to the derived default
      expect(result.after).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })
})

describe("suspended resume policy", () => {
  effect("reports expiration rather than exhaustion when a suspended retry crosses its wall-clock budget", () => {
    const flow = Flow.make("Gaps/suspend-expired", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({
        initialMs: 100,
        factor: 1,
        maxMs: 100,
        expirationMs: 150
      })
    })
    let executions = 0
    const scripted = FlowEngine.makeUnsafe({
      register: () => Effect.void,
      execute: (() =>
        Effect.sync(() => {
          executions++
          return new Flow.Suspended({})
        })) as never,
      poll: () => Effect.succeedNone,
      interrupt: () => Effect.void,
      interruptUnsafe: () => Effect.void,
      resume: () => Effect.void,
      activityExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void })),
      deferredResult: () => Effect.succeedNone,
      deferredDone: () => Effect.void,
      scheduleClock: () => Effect.void
    })
    return Effect.gen(function*() {
      const fiber = yield* flow.execute({ id: "x" }, { executionId: "run-expired" }).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(200)
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("suspendedRetryPolicy expired")
      expect(executions).toBe(2)
    }).pipe(
      Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(scripted)),
      Effect.provide(TestClock.layer())
    )
  })

  effect("dies once the suspendedRetryPolicy stops offering delays", () => {
    const Gate = DurableDeferred.make("Gaps/never-resolved", {
      success: Schema.String
    })
    const flow = Flow.make("Gaps/suspend-exhausted", {
      payload: { id: Schema.String },
      success: Schema.String,
      // one resume attempt, then the policy is exhausted
      suspendedRetryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        maxAttempts: 1
      })
    })
    const layer = flow.toLayer(() => DurableDeferred.await(Gate)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-exhausted" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("suspendedRetryPolicy exhausted")
    }).pipe(Effect.provide(layer))
  })

  effect("keeps re-polling a suspended flow until the deferred is completed", () => {
    const Gate = DurableDeferred.make("Gaps/late-resolved", {
      success: Schema.String
    })
    const flow = Flow.make("Gaps/suspend-resumes", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 })
    })
    const layer = flow.toLayer(() => DurableDeferred.await(Gate)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        flow.execute({ id: "x" }, { executionId: "run-late" })
      )
      const suspended = yield* pollUntil(flow.poll("run-late"), isSuspended)
      expect(Option.isSome(suspended)).toBe(true)
      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow, executionId: "run-late" })
      yield* DurableDeferred.succeed(Gate, { token, value: "opened" })
      expect(yield* Fiber.join(fiber)).toBe("opened")
    }).pipe(Effect.provide(layer))
  })
})

describe("activity retry give-up reasons", () => {
  effect("uses a durable retry origin when calculating an activity expiration", () => {
    const activity = Activity.make({
      name: "Gaps/durable-retry-origin",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({
        initialMs: 10,
        factor: 1,
        maxMs: 10,
        expirationMs: 1
      }),
      execute: Effect.die("activity executor must not run in this driver test")
    })
    const flow = Flow.make("Gaps/durable-retry-origin", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    let requestedKey: string | undefined
    const scripted = FlowEngine.makeUnsafe({
      register: () => Effect.void,
      execute: () => Effect.die("not used"),
      poll: () => Effect.succeedNone,
      interrupt: () => Effect.void,
      interruptUnsafe: () => Effect.void,
      resume: () => Effect.void,
      activityExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail("unavailable") })),
      activityRetryOrigin: ({ key }) => Effect.sync(() => (requestedKey = key, Option.some(0))),
      deferredResult: () => Effect.succeedNone,
      deferredDone: () => Effect.void,
      scheduleClock: () => Effect.void
    })
    return Effect.gen(function*() {
      const result = yield* scripted.activityExecute(activity, 1)
      expect(requestedKey).toBeTypeOf("string")
      expect(result._tag).toBe("Complete")
      if (result._tag === "Complete") {
        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toMatchObject({
          _tag: "@smthrs/engine/RetryPolicyExpired",
          activityName: "Gaps/durable-retry-origin",
          attempt: 1,
          expirationMs: 1,
          lastError: "unavailable"
        })
      }
    }).pipe(
      Effect.provideService(
        FlowEngine.FlowInstance,
        FlowEngine.FlowInstance.initial(flow, "run-origin")
      ),
      Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(scripted))
    )
  })

  effect("reports the observed attempt as maxAttempts when the policy declares none", () => {
    // A policy whose first delay is not positive gives up as `exhausted`
    // without ever declaring maxAttempts; the reported bound is the attempt
    // actually reached.
    let attempts = 0
    const activity = Activity.make({
      name: "Gaps/exhausted-no-max",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 0, factor: 2, maxMs: 100 }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("nope")
      })
    })
    const flow = Flow.make("Gaps/exhausted-no-max", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const layer = flow.toLayer(() => activity).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as RetryPolicy.RetryAttemptsExhausted)._tag).toBe(
        "@smthrs/engine/RetryAttemptsExhausted"
      )
      expect((defect as RetryPolicy.RetryAttemptsExhausted).attempt).toBe(1)
      expect((defect as RetryPolicy.RetryAttemptsExhausted).maxAttempts).toBe(1)
      expect((defect as RetryPolicy.RetryAttemptsExhausted).lastError).toBe("nope")
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("a nonRetryable error propagates the original typed failure, not a retry defect", () => {
    let attempts = 0
    class Fatal extends Schema.ErrorClass<Fatal>("Gaps/Fatal")({
      _tag: Schema.tag("Fatal"),
      message: Schema.String
    }) {}
    const activity = Activity.make({
      name: "Gaps/nonretryable",
      success: Schema.Number,
      error: Fatal,
      retryPolicy: RetryPolicy.make({
        initialMs: 1,
        factor: 1,
        maxMs: 1,
        nonRetryable: ["Fatal"]
      }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Fatal({ message: "no retry" }))
      })
    })
    const flow = Flow.make("Gaps/nonretryable", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Fatal
    })
    const layer = flow.toLayer(() => activity).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Fatal).message).toBe("no retry")
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("memory engine lifecycle", () => {
  effect("interruptUnsafe on an unknown execution id is a no-op", () => {
    const flow = Flow.make("Gaps/interrupt-unknown", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const layer = flow.toLayer(() => Effect.void).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const engine = yield* FlowEngine.FlowEngine
      yield* engine.interruptUnsafe(flow, "never-started")
      yield* engine.resume(flow, "never-started")
      expect(Option.isNone(yield* flow.poll("never-started"))).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("polling a flow whose defect escaped capture surfaces the defect", () => {
    const flow = Flow.make("Gaps/uncaptured-defect", {
      payload: { id: Schema.String },
      success: Schema.Void
    }).annotate(Flow.CaptureDefects, false)
    const layer = flow.toLayer(() => Effect.die("boom")).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-defect", discard: true }).pipe(Effect.exit)
      let polled = yield* flow.poll("run-defect").pipe(Effect.exit)
      for (let i = 0; i < 50 && Exit.isSuccess(polled) && Option.isNone(polled.value); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-defect").pipe(Effect.exit)
      }
      expect(Exit.isFailure(polled)).toBe(true)
      expect(Exit.isFailure(polled) && String(polled.cause)).toContain("boom")
    }).pipe(Effect.provide(layer))
  })

  effect("captures the same defect as a Complete failure exit by default", () => {
    const flow = Flow.make("Gaps/captured-defect", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const layer = flow.toLayer(() => Effect.die("boom")).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-captured", discard: true })
      let polled = yield* flow.poll("run-captured")
      for (let i = 0; i < 50 && (Option.isNone(polled) || polled.value._tag !== "Complete"); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-captured")
      }
      expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
      expect(
        Option.isSome(polled) && polled.value._tag === "Complete" &&
          Exit.isFailure(polled.value.exit) && String(polled.value.exit.cause)
      ).toContain("boom")
    }).pipe(Effect.provide(layer))
  })
})
