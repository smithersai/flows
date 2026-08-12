// Deep reviewed and polished by a human on 2026-08-10.

import type * as Crypto from "effect/Crypto"
/**
 * Issue #73: invocation keys must not depend on fiber scheduling order.
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
import { Activity, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const flow = Flow.make("InvocationKeyStability/flow", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const chargeCard = Activity.make({
  name: "InvocationKeyStability/chargeCard",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const sendEmail = Activity.make({
  name: "InvocationKeyStability/sendEmail",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const repeatedCharge = Activity.make({
  name: "InvocationKeyStability/repeated",
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
    const engine = yield* FlowRuntime.FlowRuntime
    for (const activity of activities) {
      yield* engine.activityExecute(activity as never, 1)
    }
  }).pipe(
    Effect.as(keys as ReadonlyArray<{ readonly name: string; readonly key: string }>),
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(scriptedEngine(keys)))
  ) as Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>>
}

const keyOf = (
  entries: ReadonlyArray<{ readonly name: string; readonly key: string }>,
  name: string
) => entries.filter((entry) => entry.name === name).map((entry) => entry.key)

describe("invocation key stability under permuted scheduling (issue #73)", () => {
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
  program: (engine: FlowRuntime.FlowRuntime["Service"]) => Effect.Effect<unknown, unknown, any>
): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>> => {
  const keys: Array<{ readonly name: string; readonly key: string }> = []
  const engine = scriptedEngine(keys)
  return Effect.gen(function*() {
    yield* program(engine)
  }).pipe(
    Effect.as(keys as ReadonlyArray<{ readonly name: string; readonly key: string }>),
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
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

describe("nested Activity.retry keeps inner pins across outer attempts (issue #108)", () => {
  effect("an inner block's completed dispatch keeps its key when the outer block replays", () => {
    // `outer retry { inner retry { charge }; flakyStep }`: outer attempt 1
    // charges under ordinal N and fails later; outer attempt 2 re-enters the
    // inner block. A per-invocation inner slot was rebuilt from scratch on
    // every outer attempt, so the completed charge drew a brand-new ordinal —
    // a new step key — and re-executed as a fresh attempt-1 step instead of
    // replaying (the #84/#100 stability contract, broken one nesting level
    // down).
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-nested-retry", (engine) => {
        let outerAttempt = 0
        return Activity.retry(
          Effect.gen(function*() {
            yield* Activity.retry(
              engine.activityExecute(chargeCard as never, 1),
              { times: 0 }
            )
            outerAttempt++
            if (outerAttempt < 3) return yield* Effect.fail("flaky")
          }),
          { times: 5 }
        )
      })
      const keys = keyOf(entries, chargeCard.name)
      expect(keys).toHaveLength(3)
      expect(new Set(keys).size).toBe(1)
    })
  })

  effect("inner retries still rewind their own dispatch cursors from the block entry", () => {
    // The inner block's attempts must replay the inner dispatches by position
    // from the *block entry*, not from the outer attempt's start — while a
    // sibling dispatch of the same declaration before the block keeps its own
    // pinned identity.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-nested-cursor", (engine) => {
        let innerAttempt = 0
        return Activity.retry(
          Effect.gen(function*() {
            yield* engine.activityExecute(repeatedCharge as never, 1)
            yield* Activity.retry(
              Effect.gen(function*() {
                yield* engine.activityExecute(repeatedCharge as never, 1)
                innerAttempt++
                if (innerAttempt < 2) return yield* Effect.fail("again")
              }),
              { times: 5 }
            )
          }),
          { times: 0 }
        )
      })
      const keys = keyOf(entries, repeatedCharge.name)
      // pre-block dispatch, then inner attempt 1 and inner attempt 2 of the
      // same in-block identity.
      expect(keys).toHaveLength(3)
      expect(keys[1]).toBe(keys[2])
      expect(keys[0]).not.toBe(keys[1])
    })
  })
  effect("an inner block that leaves a copied scope untouched does not move the outer cursor", () => {
    // The inner block's private cursor view copies the outer cursor for the
    // scope dispatched before it; since the block never dispatches that
    // scope, its exit propagation is a no-op and the outer block's later
    // dispatch still takes the next position, not a replayed one.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-nested-untouched", (engine) =>
        Activity.retry(
          Effect.gen(function*() {
            yield* engine.activityExecute(repeatedCharge as never, 1)
            yield* Activity.retry(Effect.void, { times: 0 })
            yield* engine.activityExecute(repeatedCharge as never, 1)
          }),
          { times: 0 }
        ))
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
    })
  })
})

describe("concurrent sibling retry blocks inside one outer block (issue #116)", () => {
  // Keyed overlap of one declaration is sanctioned (issue #111), so two
  // sibling `Activity.retry` blocks may run concurrently inside one outer
  // block. Sharing one mutable cursor map made a sibling's attempt boundary
  // clear *every* scope's dispatch cursor: the victim's next dispatch then
  // re-consumed its first pinned ordinal — a duplicate step key silently
  // replaying another dispatch's recorded outcome.
  const keyed = (idempotencyKey: string) =>
    Activity.make({
      name: "InvocationKeyStability/sibling",
      tier: "irreversible",
      idempotencyKey,
      success: Schema.Void,
      execute: Effect.void
    })
  const siblingA = keyed("sibling-a")
  const siblingB = keyed("sibling-b")

  effect("a sibling's retry boundary never rewinds another block's mid-flight cursor", () => {
    return Effect.gen(function*() {
      const bFirstDone = yield* Deferred.make<void>()
      const aRetried = yield* Deferred.make<void>()
      const entries = yield* driveProgram("ordinal-concurrent-siblings", (engine) =>
        Activity.retry(
          Effect.all([
            Activity.retry(
              Effect.gen(function*() {
                const attempt = yield* Activity.CurrentAttempt
                yield* engine.activityExecute(siblingA as never, 1)
                if (attempt === 1) {
                  // Fail only after B's first dispatch is recorded, so A's
                  // attempt boundary fires while B is mid-flight between its
                  // two dispatches.
                  yield* Deferred.await(bFirstDone)
                  return yield* Effect.fail("boom")
                }
                yield* Deferred.done(aRetried, Exit.void)
              }),
              { times: 5 }
            ),
            Activity.retry(
              Effect.gen(function*() {
                yield* engine.activityExecute(siblingB as never, 1)
                yield* Deferred.done(bFirstDone, Exit.void)
                yield* Deferred.await(aRetried)
                yield* engine.activityExecute(siblingB as never, 1)
              }),
              { times: 0 }
            )
          ], { concurrency: 2 }),
          { times: 0 }
        ))
      // Deterministic interleaving under the latches: A attempt 1, B first
      // dispatch, A attempt 2, B second dispatch.
      expect(entries).toHaveLength(4)
      const [a1, b1, a2, b2] = entries.map((entry) => entry.key)
      // A's own replay still pins its dispatch across attempts (issue #108).
      expect(a2).toBe(a1)
      // B's second dispatch owns its own second ordinal: A's boundary must
      // not have rewound B's cursor onto B's first pinned ordinal.
      expect(b2).not.toBe(b1)
      // And no cross-sibling collision either.
      expect(new Set([a1, b1, b2]).size).toBe(3)
    })
  })
})

describe("same-name invocation identity (issue #85)", () => {
  const notify = (idempotencyKey: string) =>
    Activity.make({
      name: "InvocationKeyStability/notify",
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

  const notifyContent = (user: string) =>
    Activity.make({
      name: "InvocationKeyStability/notifyContent",
      tier: "irreversible",
      idempotencyKey: { user },
      success: Schema.Void,
      execute: Effect.void
    })
  const notifyContentA = notifyContent("user-a")
  const notifyContentB = notifyContent("user-b")

  effect("an object-form idempotencyKey pins each invocation's key under swapped arrival order (issue #101)", () => {
    // The idempotency component is a union: an object must
    // refine the allocation scope exactly as a string does. Refining only
    // the string form left object-keyed activities on the name-only counter,
    // so a replay with reversed fiber arrival swapped their ordinals — and
    // with them the recorded attempt rows and outcomes.
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-object-key-run", [notifyContentA, notifyContentB])
      const replay = yield* drive("ordinal-object-key-run", [notifyContentB, notifyContentA])
      const [keyA1, keyB1] = first.map((entry) => entry.key)
      const [keyB2, keyA2] = replay.map((entry) => entry.key)
      expect(keyA1).toBe(keyA2)
      expect(keyB1).toBe(keyB2)
      expect(keyA1).not.toBe(keyB1)
    })
  })
})

describe("same identity dispatched twice inside Activity.retry (issue #100)", () => {
  effect("each dispatch of one declaration in a retry block owns its own key", () => {
    // `Activity.retry(gen { yield* charge; yield* charge })`: a single-valued
    // slot handed the first dispatch's ordinal to the second, so under a
    // durable engine the second charge silently replayed the first's
    // recorded outcome instead of executing.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-same-identity-block", (engine) =>
        Activity.retry(
          Effect.gen(function*() {
            yield* engine.activityExecute(repeatedCharge as never, 1)
            yield* engine.activityExecute(repeatedCharge as never, 1)
          }),
          { times: 0 }
        ))
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
    })
  })

  effect("both dispatches keep their identities across every attempt of the sequence", () => {
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-same-identity-retry", (engine) => {
        let attempt = 0
        return Activity.retry(
          Effect.gen(function*() {
            yield* engine.activityExecute(repeatedCharge as never, 1)
            yield* engine.activityExecute(repeatedCharge as never, 1)
            attempt++
            if (attempt < 3) return yield* Effect.fail("again")
          }),
          { times: 5 }
        )
      })
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(6)
      // Attempt n dispatches the same (first, second) pair of identities.
      expect(new Set(keys).size).toBe(2)
      expect(keys[0]).not.toBe(keys[1])
      expect(keys.slice(2)).toEqual([keys[0], keys[1], keys[0], keys[1]])
    })
  })
})
