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
