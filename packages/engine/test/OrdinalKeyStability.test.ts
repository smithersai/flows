/**
 * Issue #73: ordinal step keys must not depend on fiber scheduling order.
 *
 * Compensable, irreversible, and unsealed activities are keyed by
 * `(runId, ordinal, tier)`, and the ordinal used to come from one per-run
 * counter bumped in the order fibers happened to reach `activityExecute`.
 * Nothing serializes that order — a flow body may run activities under
 * `Effect.all({ concurrency: "unbounded" })`, and on replay a recorded
 * activity resolves from the journal near-instantly while an unrecorded one
 * runs live — so a permuted interleaving aliased one activity onto another's
 * recorded attempt rows, checkpoint, and outcome.
 *
 * The two drives below dispatch the same pair of activities in opposite
 * orders, which is exactly what a permuted interleaving produces. Each
 * activity must keep its own identity across both.
 */
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const flow = Flow.make("OrdinalKeyStability/flow", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const chargeCard = Activity.make({
  name: "OrdinalKeyStability/chargeCard",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const sendEmail = Activity.make({
  name: "OrdinalKeyStability/sendEmail",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const repeatedCharge = Activity.make({
  name: "OrdinalKeyStability/repeated",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

/** Captures the step key the engine allocates for each dispatch. */
const scriptedEngine = (keys: Array<{ readonly name: string; readonly key: string }>) =>
  FlowEngine.makeUnsafe({
    register: () => Effect.void,
    execute: () => Effect.die("not used"),
    poll: () => Effect.succeedNone,
    interrupt: () => Effect.void,
    interruptUnsafe: () => Effect.void,
    resume: () => Effect.void,
    activityExecute: (input) =>
      Effect.sync(() => {
        keys.push({ name: input.activity.name, key: input.key })
        return new Flow.Complete({ exit: Exit.void })
      }),
    deferredResult: () => Effect.succeedNone,
    deferredDone: () => Effect.void,
    scheduleClock: () => Effect.void
  })

/** One drive of a run: dispatches `activities` in the given order. */
const drive = (
  executionId: string,
  activities: ReadonlyArray<Activity.Any>
): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>> => {
  const keys: Array<{ readonly name: string; readonly key: string }> = []
  return Effect.gen(function*() {
    const engine = yield* FlowEngine.FlowEngine
    for (const activity of activities) {
      yield* engine.activityExecute(activity as never, 1)
    }
  }).pipe(
      Effect.as(keys as ReadonlyArray<{ readonly name: string; readonly key: string }>),
      Effect.provideService(
        FlowEngine.FlowInstance,
        FlowEngine.FlowInstance.initial(flow, executionId)
      ),
      Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(scriptedEngine(keys)))
    ) as Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>>
}

const keyOf = (
  entries: ReadonlyArray<{ readonly name: string; readonly key: string }>,
  name: string
) => entries.filter((entry) => entry.name === name).map((entry) => entry.key)

describe("ordinal step key stability under permuted scheduling (issue #73)", () => {
  effect("keeps each activity's key when a replay dispatches the pair in the opposite order", () => {
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-stability-run", [chargeCard, sendEmail])
      const replay = yield* drive("ordinal-stability-run", [sendEmail, chargeCard])

      expect(keyOf(first, chargeCard.name)).toEqual(keyOf(replay, chargeCard.name))
      expect(keyOf(first, sendEmail.name)).toEqual(keyOf(replay, sendEmail.name))
      // Distinct activities still never share an identity.
      expect(keyOf(first, chargeCard.name)).not.toEqual(keyOf(first, sendEmail.name))
    })
  })

  effect("still separates repeated invocations of one activity within a run", () => {
    return Effect.gen(function*() {
      const entries = yield* drive("ordinal-repeat-run", [
        repeatedCharge,
        repeatedCharge,
        repeatedCharge
      ])
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(3)
      expect(new Set(keys).size).toBe(3)
    })
  })

  effect("keeps repeated invocations aligned across a replay of the same sequence", () => {
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-repeat-replay", [repeatedCharge, chargeCard, repeatedCharge])
      // The replay reaches `chargeCard` last; the two `repeated` dispatches
      // keep their first and second identities regardless.
      const replay = yield* drive("ordinal-repeat-replay", [repeatedCharge, repeatedCharge, chargeCard])
      expect(keyOf(first, repeatedCharge.name)).toEqual(keyOf(replay, repeatedCharge.name))
      expect(keyOf(first, chargeCard.name)).toEqual(keyOf(replay, chargeCard.name))
    })
  })
})

/** One drive of a run executing an arbitrary program against the engine. */
const driveProgram = (
  executionId: string,
  program: (engine: FlowEngine.FlowEngine["Service"]) => Effect.Effect<void, unknown, FlowEngine.FlowInstance>
): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>> => {
  const keys: Array<{ readonly name: string; readonly key: string }> = []
  const engine = scriptedEngine(keys)
  return Effect.gen(function*() {
    yield* program(engine)
  }).pipe(
    Effect.as(keys as ReadonlyArray<{ readonly name: string; readonly key: string }>),
    Effect.provideService(
      FlowEngine.FlowInstance,
      FlowEngine.FlowInstance.initial(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(engine))
  ) as Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>>
}

describe("ordinal slots inside Activity.retry (issue #84)", () => {
  effect("a differently-named activity in one retry block keeps its own name-scoped identity", () => {
    // `Activity.retry(gen { yield* A; yield* B })` followed by a plain
    // `yield* B`: the in-block B must consume `activity:B`'s counter, not
    // inherit A's slot value, or the later independent B collides with it.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-slot-run", (engine) =>
        Effect.gen(function*() {
          yield* Activity.retry(
            Effect.gen(function*() {
              yield* engine.activityExecute(chargeCard as never, 1)
              yield* engine.activityExecute(sendEmail as never, 1)
            }),
            { times: 0 }
          )
          yield* engine.activityExecute(sendEmail as never, 1)
        }))
      const emailKeys = keyOf(entries, sendEmail.name)
      expect(emailKeys).toHaveLength(2)
      expect(new Set(emailKeys).size).toBe(2)
      // And no key is shared across differently-named activities either.
      expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length)
    })
  })

  effect("each activity inside a retry block keeps a stable ordinal across attempts", () => {
    // The per-name slot map must still pin each activity of the block to one
    // ordinal for the whole retry sequence.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-slot-retry-run", (engine) => {
        let attempt = 0
        return Activity.retry(
          Effect.gen(function*() {
            yield* engine.activityExecute(chargeCard as never, 1)
            yield* engine.activityExecute(sendEmail as never, 1)
            attempt++
            if (attempt < 3) return yield* Effect.fail("again")
          }),
          { times: 5 }
        )
      })
      expect(keyOf(entries, chargeCard.name)).toHaveLength(3)
      expect(new Set(keyOf(entries, chargeCard.name)).size).toBe(1)
      expect(keyOf(entries, sendEmail.name)).toHaveLength(3)
      expect(new Set(keyOf(entries, sendEmail.name)).size).toBe(1)
      expect(keyOf(entries, chargeCard.name)[0]).not.toEqual(keyOf(entries, sendEmail.name)[0])
    })
  })
})

describe("same-name invocation identity (issue #85)", () => {
  const notify = (idempotencyKey: string) =>
    Activity.make({
      name: "OrdinalKeyStability/notify",
      tier: "irreversible",
      idempotencyKey,
      success: Schema.Void,
      execute: Effect.void
    })
  const notifyA = notify("user-a")
  const notifyB = notify("user-b")

  effect("a declared idempotencyKey pins each invocation's key under swapped arrival order", () => {
    // Two concurrent invocations of one activity name with distinguishable
    // inputs must not swap recorded outcomes when a replay reverses arrival
    // order: the declared identity, not the fiber schedule, owns the key.
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-same-name-run", [notifyA, notifyB])
      const replay = yield* drive("ordinal-same-name-run", [notifyB, notifyA])
      const byOrder = (entries: ReadonlyArray<{ readonly key: string }>) => entries.map((entry) => entry.key)
      const [keyA1, keyB1] = byOrder(first)
      const [keyB2, keyA2] = byOrder(replay)
      expect(keyA1).toBe(keyA2)
      expect(keyB1).toBe(keyB2)
      expect(keyA1).not.toBe(keyB1)
    })
  })

  effect("repeated invocations of one declared identity stay separated within a run", () => {
    return Effect.gen(function*() {
      const entries = yield* drive("ordinal-same-key-repeat-run", [notifyA, notifyA])
      const keys = entries.map((entry) => entry.key)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
    })
  })
})
