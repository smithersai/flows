/**
 * Issue #75: a sealed activity's content key omitted the two pieces of key
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
import type { StepKey } from "@smithers/keys"
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const flow = Flow.make("ContentEnvironmentKeys/flow", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const hermeticMetadata = {
  readSet: [{ path: "src/input.ts", digest: "d1" }],
  writeSet: ["out/artifact"],
  boundaryMode: "hard"
} as const

const sealed = (idempotencyKey: string | StepKey.ContentIdentity) =>
  Activity.make({
    name: "ContentEnvironmentKeys/summarize",
    success: Schema.Void,
    idempotencyKey,
    metadata: hermeticMetadata,
    execute: Effect.void
  })

/** Dispatches `activity` under `environment` and returns the step key. */
const keyUnder = (
  activity: Activity.Any,
  environment?: Activity.ContentEnvironment
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
      : Effect.provideService(Activity.CurrentContentEnvironment, environment),
    Effect.provideService(
      FlowEngine.FlowInstance,
      FlowEngine.FlowInstance.initial(flow, "content-environment-run")
    ),
    Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(engine))
  ) as Effect.Effect<string>
}

const sonnet: Activity.ContentEnvironment = {
  layers: ["Model=sonnet"],
  capabilities: { net: ["api.anthropic.com"] }
}

describe("sealed content keys fold the resolved environment (issue #75)", () => {
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

  effect("attenuating capabilities changes the digest of a string-form key", () => {
    return Effect.gen(function*() {
      const activity = sealed("order-123")
      const broad = yield* keyUnder(activity, sonnet)
      const attenuated = yield* keyUnder(activity, { ...sonnet, capabilities: { net: [] } })
      expect(broad).not.toBe(attenuated)
    })
  })

  effect("a caller-supplied content identity cannot opt out of the environment", () => {
    return Effect.gen(function*() {
      const identity: StepKey.ContentIdentity = {
        body: "ContentEnvironmentKeys/rename-stable",
        inputs: {},
        layers: [],
        capabilities: {}
      }
      const activity = sealed(identity)
      const underSonnet = yield* keyUnder(activity, sonnet)
      const underOpus = yield* keyUnder(activity, { ...sonnet, layers: ["Model=opus"] })
      expect(underSonnet).not.toBe(underOpus)
      // The caller's own declared material still counts.
      const richer = sealed({ ...identity, layers: ["Caller=declared"] })
      expect(yield* keyUnder(richer, sonnet)).not.toBe(underSonnet)
    })
  })

  effect("an undeclared environment is the empty one", () => {
    return Effect.gen(function*() {
      const activity = sealed("order-123")
      expect(yield* keyUnder(activity)).toBe(
        yield* keyUnder(activity, { layers: [], capabilities: {} })
      )
    })
  })

  effect("a shared capability group unions with the caller's patterns instead of replacing them", () => {
    // Issue #89: `withEnvironment` merged capabilities with an object spread,
    // so a group declared by both the caller and the environment collapsed to
    // the environment's patterns alone — two activities declaring distinct
    // patterns under a shared group name hashed identically.
    return Effect.gen(function*() {
      const identity = (patterns: ReadonlyArray<string>): StepKey.ContentIdentity => ({
        body: "ContentEnvironmentKeys/union",
        inputs: {},
        layers: [],
        capabilities: { fs: patterns }
      })
      const environment: Activity.ContentEnvironment = {
        layers: [],
        capabilities: { fs: ["/workspace"] }
      }
      const readsA = yield* keyUnder(sealed(identity(["/data/a"])), environment)
      const readsB = yield* keyUnder(sealed(identity(["/data/b"])), environment)
      expect(readsA).not.toBe(readsB)
      // The union is order-insensitive: caller + environment patterns hash the
      // same as a caller that declared both itself.
      expect(yield* keyUnder(sealed(identity(["/workspace", "/data/a"])), { layers: [], capabilities: {} }))
        .toBe(readsA)
    })
  })

  effect("layerContentEnvironment declares the environment for a composition", () => {
    // Issue #88: the declaration must be wireable as a layer so shipped
    // compositions (the plugin kernel, hand-wired stacks) provide it.
    return Effect.gen(function*() {
      const environment = yield* Activity.CurrentContentEnvironment.pipe(
        Effect.provide(Activity.layerContentEnvironment(sonnet))
      )
      expect(environment).toEqual(sonnet)
    })
  })

  effect("the environment does not enter ordinal keys", () => {
    return Effect.gen(function*() {
      // Ordinal keys are run-local and never reused across runs, so the
      // environment is not key material for them.
      const ordinalActivity = Activity.make({
        name: "ContentEnvironmentKeys/ordinal",
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
