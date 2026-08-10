// Deep reviewed and polished by a human on 2026-08-10.

import type * as Crypto from "effect/Crypto"
/**
 * Issue #75: a sealed activity's cache key omitted the two pieces of key
 * material the Step Keys spec calls mandatory — the resolved layers and the
 * capability set — by hard-coding `layers: []` and `capabilities: {}` for the
 * string form and passing the object form through verbatim.
 *
 * Sealed + `boundaryMode: "hard"` activities are cross-run cacheable, so a
 * digest blind to the environment served a result computed under Model=sonnet
 * to a run wired to Model=opus, or one computed with broad capabilities to a
 * run that attenuated them. The boundary descriptor (read set, write set,
 * boundary mode) is filesystem material and changes for neither swap.
 *
 * The environment is engine-resolved material, so — like the boundary
 * descriptor of issue #57 — it is folded into BOTH key forms and a caller
 * cannot opt out of it.
 */
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const flow = Flow.make("CacheEnvironmentKeys/flow", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const hermeticMetadata = {
  readSet: [{ path: "src/input.ts", digest: "d1" }],
  writeSet: ["out/artifact"],
  boundaryMode: "hard"
} as const

const sealed = (idempotencyKey: Activity.IdempotencyKey) =>
  Activity.make({
    name: "CacheEnvironmentKeys/summarize",
    success: Schema.Void,
    idempotencyKey,
    metadata: hermeticMetadata,
    execute: Effect.void
  })

/** Dispatches `activity` under `environment` and returns the step key. */
const keyUnder = (
  activity: Activity.Any,
  environment?: Activity.CacheEnvironment,
  executionId = "content-environment-run"
): Effect.Effect<string> => {
  let captured: string | undefined
  const engine = FlowEngine.makeUnsafe({
    register: () => Effect.void,
    execute: () => Effect.die("not used"),
    poll: () => Effect.succeedNone,
    interrupt: () => Effect.void,
    interruptUnsafe: () => Effect.void,
    resume: () => Effect.void,
    activityExecute: (input) =>
      Effect.sync(() => {
        captured = input.key
        return new Flow.Complete({ exit: Exit.void })
      }),
    deferredResult: () => Effect.succeedNone,
    deferredDone: () => Effect.void,
    scheduleClock: () => Effect.void
  })
  return Effect.gen(function*() {
    const service = yield* FlowEngine.FlowEngine
    yield* service.activityExecute(activity as never, 1)
    return captured!
  }).pipe(
    environment === undefined
      ? (self) => self
      : Effect.provideService(Activity.CurrentCacheEnvironment, environment),
    Effect.provideService(
      FlowEngine.FlowInstance,
      FlowEngine.FlowInstance.initial(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(engine))
  ) as Effect.Effect<string>
}

const sonnet: Activity.CacheEnvironment = {
  layers: ["Model=sonnet"],
  capabilities: { net: ["api.anthropic.com"] }
}

describe("sealed cache keys fold the resolved environment (issue #75)", () => {
  it("validates complete cache environments", () => {
    expect(Schema.decodeUnknownSync(Activity.CacheEnvironment)(sonnet)).toEqual(sonnet)
    expect(() =>
      Schema.decodeUnknownSync(Activity.CacheEnvironment)({
        layers: [],
        capabilities: { "": ["read"] }
      })
    ).toThrow("Capability names must not be empty")
  })

  effect("a swapped layer changes the digest of a string-form key", () => {
    return Effect.gen(function*() {
      const activity = sealed("order-123")
      const underSonnet = yield* keyUnder(activity, sonnet)
      const underOpus = yield* keyUnder(activity, { ...sonnet, layers: ["Model=opus"] })
      expect(underSonnet).not.toBe(underOpus)
      // Same environment, same digest: the key stays reusable across runs.
      expect(yield* keyUnder(activity, { layers: ["Model=sonnet"], capabilities: { net: ["api.anthropic.com"] } }))
        .toBe(underSonnet)
    })
  })

  effect("reordering environment layers changes the digest", () => {
    return Effect.gen(function*() {
      const activity = sealed("order-123")
      const modelThenHost = yield* keyUnder(activity, {
        layers: ["Model=sonnet", "Host=node"],
        capabilities: {}
      })
      const hostThenModel = yield* keyUnder(activity, {
        layers: ["Host=node", "Model=sonnet"],
        capabilities: {}
      })
      expect(modelThenHost).not.toBe(hostThenModel)
    })
  })

  effect("attenuating capabilities changes the digest of a string-form key", () => {
    return Effect.gen(function*() {
      const activity = sealed("order-123")
      const broad = yield* keyUnder(activity, sonnet)
      const attenuated = yield* keyUnder(activity, { ...sonnet, capabilities: { net: [] } })
      expect(broad).not.toBe(attenuated)
    })
  })

  effect("a caller-supplied cache key input cannot opt out of the environment", () => {
    return Effect.gen(function*() {
      const identity = { operation: "CacheEnvironmentKeys/rename-stable" }
      const activity = sealed(identity)
      const underSonnet = yield* keyUnder(activity, sonnet)
      const underOpus = yield* keyUnder(activity, { ...sonnet, layers: ["Model=opus"] })
      expect(underSonnet).not.toBe(underOpus)
      // The caller's own declared material still counts.
      const richer = sealed({ ...identity, input: "changed" })
      expect(yield* keyUnder(richer, sonnet)).not.toBe(underSonnet)
    })
  })

  effect("an undeclared environment is scoped to the current execution", () => {
    return Effect.gen(function*() {
      const activity = sealed("order-123")
      expect(yield* keyUnder(activity)).not.toBe(
        yield* keyUnder(activity, { layers: [], capabilities: {} })
      )
      expect(yield* keyUnder(activity, undefined, "other-run")).not.toBe(
        yield* keyUnder(activity, undefined, "first-run")
      )
    })
  })

  effect("caller and environment capability identities cannot alias through concatenation", () => {
    return Effect.gen(function*() {
      const identity = (patterns: ReadonlyArray<string>): Schema.JsonObject => ({
        operation: "CacheEnvironmentKeys/union",
        authority: patterns
      })
      const environment: Activity.CacheEnvironment = {
        layers: [],
        capabilities: { fs: ["/workspace"] }
      }
      const readsA = yield* keyUnder(sealed(identity(["/data/a"])), environment)
      const readsB = yield* keyUnder(sealed(identity(["/data/b"])), environment)
      expect(readsA).not.toBe(readsB)
      // Caller-owned and engine-resolved authority occupy distinct namespaces:
      // moving one pattern across that boundary must re-key.
      expect(yield* keyUnder(sealed(identity(["/workspace", "/data/a"])), { layers: [], capabilities: {} }))
        .not.toBe(readsA)
    })
  })

  effect("layerCacheEnvironment declares the environment for a composition", () => {
    // Issue #88: the declaration must be wireable as a layer so shipped
    // compositions (the plugin kernel, hand-wired stacks) provide it.
    return Effect.gen(function*() {
      const environment = yield* Activity.CurrentCacheEnvironment.pipe(
        Effect.provide(Activity.layerCacheEnvironment(sonnet))
      )
      expect(environment).toEqual(sonnet)
    })
  })

  effect("the environment does not enter invocation keys", () => {
    return Effect.gen(function*() {
      // Invocation keys are run-local and never reused across runs, so the
      // environment is not key input for them.
      const ordinalActivity = Activity.make({
        name: "CacheEnvironmentKeys/ordinal",
        tier: "irreversible",
        success: Schema.Void,
        execute: Effect.void
      })
      expect(yield* keyUnder(ordinalActivity, sonnet)).toBe(
        yield* keyUnder(ordinalActivity, { ...sonnet, layers: ["Model=opus"] })
      )
    })
  })
})
