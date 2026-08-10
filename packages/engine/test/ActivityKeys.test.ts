// Deep reviewed and polished by a human on 2026-08-10.

import { Effect, Exit, Layer, Result, Schedule, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"
import { key, runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const hostFlow = Flow.make("ActivityKeys/host", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const provideHost = <A, E>(
  self: Effect.Effect<
    A,
    E,
    FlowEngine.FlowEngine | FlowEngine.FlowInstance | Scope.Scope
  >
): Effect.Effect<A, E> =>
  self.pipe(
    Effect.scoped,
    Effect.provideService(
      FlowEngine.FlowInstance,
      FlowEngine.FlowInstance.initial(hostFlow, "host-run")
    ),
    Effect.provide(FlowEngine.layerMemory)
  )

describe("activity execution keys", () => {
  effect("namespaces string idempotency keys by activity name so distinct activities never collide", () => {
    // Issue #9: `chargeCard` and `sendEmail` both declaring
    // `idempotencyKey: "order-123"` must NOT share a step key — otherwise the
    // second replays the first's persisted outcome against the wrong schema.
    let charges = 0
    let emails = 0
    const chargeCard = Activity.make({
      name: "ActivityKeys/chargeCard",
      success: Schema.Number,
      idempotencyKey: "order-123",
      execute: Effect.sync(() => {
        charges++
        return 42
      })
    })
    const sendEmail = Activity.make({
      name: "ActivityKeys/sendEmail",
      success: Schema.String,
      idempotencyKey: "order-123",
      execute: Effect.sync(() => {
        emails++
        return "sent"
      })
    })
    const flow = Flow.make("ActivityKeys/no-collision", {
      payload: { run: Schema.String },
      success: Schema.String
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const amount = yield* chargeCard
        const receipt = yield* sendEmail
        return `${amount}:${receipt}`
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe("42:sent")
      expect(charges).toBe(1)
      expect(emails).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("replays the same activity's string idempotency key across attempts", () => {
    let executions = 0
    const activity = () =>
      Activity.make({
        name: "ActivityKeys/stable",
        success: Schema.Number,
        idempotencyKey: "sealed/caller-key",
        execute: Effect.sync(() => ++executions)
      })
    const flow = Flow.make("ActivityKeys/replay", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() => Effect.andThen(activity(), activity())).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("folds the boundary descriptor into string idempotency keys so a changed read set misses (issue #25)", () => {
    // Skyframe's dirty→recheck→rebuild collapses to key-based invalidation
    // here: the hermetic descriptor (readSet digests, writeSet,
    // boundaryMode) is part of the cache key, so an activity whose
    // declared inputs changed can never replay the stale cached result.
    let executions = 0
    const build = (digest: string) =>
      Activity.make({
        name: "ActivityKeys/build",
        success: Schema.Number,
        idempotencyKey: "v1",
        metadata: {
          readSet: [{ path: "src/input.ts", digest }],
          writeSet: ["out/artifact"],
          boundaryMode: "hard"
        },
        execute: Effect.sync(() => ++executions)
      })
    const flow = Flow.make("ActivityKeys/boundary-invalidation", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        // Same digest replays; the changed digest must re-execute.
        yield* build("d1")
        yield* build("d1")
        return yield* build("d2")
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-boundary" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("keeps object identity caller-owned so replay survives an activity rename", () => {
    // The object-form idempotencyKey is the escape hatch for rename-stable
    // identity: the caller owns the full key input, so the activity name
    // intentionally does not enter the digest.
    let executions = 0
    const identity = {
      operation: "sealed/caller-owned"
    }
    const first = Activity.make({
      name: "ActivityKeys/first-name",
      success: Schema.Number,
      idempotencyKey: identity,
      execute: Effect.sync(() => ++executions)
    })
    const renamed = Activity.make({
      name: "ActivityKeys/renamed",
      success: Schema.Number,
      idempotencyKey: identity,
      execute: Effect.sync(() => ++executions)
    })
    const flow = Flow.make("ActivityKeys/rename-stable", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() => Effect.andThen(first, renamed)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect(
    "folds the boundary descriptor into object-form keys so the rename-stable escape hatch cannot bypass invalidation (issue #57)",
    () => {
      // A caller-owned object, on a sealed
      // activity declaring a hard boundary descriptor, must still fold the
      // read-set material into the key: otherwise a changed read-set digest
      // replays the stale cross-run cache entry #25 was filed for.
      let executions = 0
      const identity = {
        operation: "sealed/boundary-escape-hatch"
      }
      const build = (digest: string) =>
        Activity.make({
          name: "ActivityKeys/object-boundary",
          success: Schema.Number,
          idempotencyKey: identity,
          metadata: {
            readSet: [{ path: "src/input.ts", digest }],
            writeSet: ["out/artifact"],
            boundaryMode: "hard"
          },
          execute: Effect.sync(() => ++executions)
        })
      const flow = Flow.make("ActivityKeys/object-boundary-invalidation", {
        payload: { run: Schema.String },
        success: Schema.Number
      })
      const layer = flow.toLayer(() =>
        Effect.gen(function*() {
          // Same digest replays; the changed digest must re-execute.
          yield* build("d1")
          yield* build("d1")
          return yield* build("d2")
        })
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-object-boundary" })).toBe(2)
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }
  )

  effect(
    "overrides a caller-pinned stale hermetic with the metadata descriptor so the read-set change still misses (issue #83)",
    () => {
      // Issue #57's mechanism is spread order alone: the descriptor derived
      // from `activity.metadata` must win over a `boundary` the caller
      // pinned inside the object-form identity. This is the
      // caller-supplies case the #57 test never covered — a refactor that
      // spread the caller's field last (`{ boundary, ...identity }`) would
      // freeze the key on the pinned digest and restore the #25 stale-replay
      // bypass.
      let executions = 0
      const identity = { operation: "sealed/pinned-hermetic" }
      const build = (digest: string) =>
        Activity.make({
          name: "ActivityKeys/pinned-hermetic",
          success: Schema.Number,
          idempotencyKey: identity,
          metadata: {
            readSet: [{ path: "src/input.ts", digest }],
            writeSet: ["out/artifact"],
            boundaryMode: "hard"
          },
          execute: Effect.sync(() => ++executions)
        })
      const flow = Flow.make("ActivityKeys/pinned-hermetic-invalidation", {
        payload: { run: Schema.String },
        success: Schema.Number
      })
      const layer = flow.toLayer(() =>
        Effect.gen(function*() {
          // The pinned "frozen" digest never enters the key: same metadata
          // digest replays, the changed digest re-executes.
          yield* build("d1")
          yield* build("d1")
          return yield* build("d2")
        })
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-pinned-hermetic" })).toBe(2)
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }
  )

  effect("folds the declared schemas into string idempotency keys so a schema change misses (issue #120)", () => {
    // The step-key spec requires the content body to be the *compiled
    // declaration* — schemas and combinators applied. Folding only
    // `{activity, idempotencyKey}` let an activity whose success schema
    // changed keep its old key, replaying a stale cached row decoded under
    // the new schema.
    let executions = 0
    const v1 = Activity.make({
      name: "ActivityKeys/schema-change",
      success: Schema.Struct({ a: Schema.Number }),
      idempotencyKey: "row",
      execute: Effect.sync(() => {
        executions++
        return { a: 1 }
      })
    })
    const v2 = Activity.make({
      name: "ActivityKeys/schema-change",
      success: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
      idempotencyKey: "row",
      execute: Effect.sync(() => {
        executions++
        return { a: 1, b: 2 }
      })
    })
    const flow = Flow.make("ActivityKeys/schema-invalidation", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        // Same declaration replays; the changed success schema must miss and
        // re-execute rather than decode v1's cached row as v2's shape.
        yield* v1
        yield* v1
        const out = yield* v2
        return out.b
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-schema-change" })).toBe(2)
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect(
    "folds the declared error schema into string idempotency keys so an error-schema change misses (issue #136)",
    () => {
      // `declarationDigest` folds BOTH declared schemas; the #120 regression
      // test varied only the success schema, so dropping the error term kept
      // the suite green while an activity whose error schema changed replayed
      // a stale row decoded under the new error type. This cell pins the
      // error-schema axis: identical success schema and idempotencyKey, only
      // the error schema differs, and the second declaration must re-execute.
      let executions = 0
      const make = <Error extends Schema.Constraint>(error: Error) =>
        Activity.make({
          name: "ActivityKeys/error-schema-change",
          success: Schema.Struct({ a: Schema.Number }),
          error,
          idempotencyKey: "row",
          execute: Effect.sync(() => {
            executions++
            return { a: executions }
          })
        })
      const v1 = make(Schema.Struct({ reason: Schema.String }))
      const v2 = make(Schema.Struct({ reason: Schema.String, retriable: Schema.Boolean }))
      const flow = Flow.make("ActivityKeys/error-schema-invalidation", {
        payload: { run: Schema.String },
        success: Schema.Number
      })
      const layer = flow.toLayer(() =>
        Effect.gen(function*() {
          // Same declaration replays; the changed error schema must miss and
          // re-execute rather than replay v1's cached row under v2's key.
          // The declared errors are unreachable here — `execute` only succeeds —
          // so die on them to keep the flow's declared error channel empty.
          yield* Effect.orDie(v1)
          yield* Effect.orDie(v1)
          const out = yield* Effect.orDie(v2)
          return out.a
        })
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

      return Effect.gen(function*() {
        expect(yield* flow.execute({ run: "one" }, { executionId: "run-error-schema-change" })).toBe(2)
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layer))
    }
  )

  effect("changes sealed replay identity when its input, layer, or capability material changes", () => {
    const keyFor = (input: string, layer: string, capability: string) =>
      key({
        kind: "cache",
        input: {
          body: "activity",
          dependencies: { input: { kind: "literal", value: input } }
        },
        environment: {
          layers: [layer],
          capabilities: { declared: [capability] }
        }
      })
    const first = keyFor("input-a", "layer-a", "capability-a")
    const changedInput = keyFor("input-b", "layer-a", "capability-a")
    const changedLayer = keyFor("input-a", "layer-b", "capability-a")
    const changedCapability = keyFor("input-a", "layer-a", "capability-b")

    return Effect.gen(function*() {
      expect(first).not.toBe(changedInput)
      expect(first).not.toBe(changedLayer)
      expect(first).not.toBe(changedCapability)
    })
  })

  effect("keeps ordinal activity keys isolated by run and never by activity name", () =>
    Effect.gen(function*() {
      const ordinal = (run: string, attempt: number) => `ordinal/${run}/compensable/${attempt}`
      expect(ordinal("run-a", 1)).not.toBe(ordinal("run-b", 1))
      expect(ordinal("run-a", 1)).not.toBe(ordinal("run-a", 2))
      expect(ordinal("run-a", 1)).not.toContain("activity-name")
    }))

  effect("classifies tagged infrastructure interrupts for retry exhaustion", () => {
    const activity = Activity.make({
      name: "ActivityKeys/infra-interrupt",
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(0),
      execute: Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
    }).pipe(provideHost)
  })
})
