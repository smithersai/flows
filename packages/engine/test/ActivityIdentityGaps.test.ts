// Deep reviewed and polished by a human on 2026-08-10.

import { Activity, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Result, Schedule, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { invocationKey as decodeInvocationKey, runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const hostFlow = Flow.make("IdentityGaps/host", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const provideHost = <A, E>(
  self: Effect.Effect<
    A,
    E,
    FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Scope.Scope
  >
): Effect.Effect<A, E> =>
  self.pipe(
    Effect.scoped,
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(hostFlow, "host-run")
    ),
    Effect.provide(FlowEngine.layerMemory)
  )

const invocationKey = (runId: string, ordinal: number, parentScope?: string) =>
  decodeInvocationKey({
    runId,
    ordinal,
    tier: "unsealed",
    ...(parentScope === undefined ? {} : { parentScope })
  })

describe("Activity.idempotencyKey scoping", () => {
  effect("allocates run-local ordinals and never folds the diagnostic name into identity", () => {
    const flowActivityDeclaration = Activity.make("IdentityGaps/ordinals/activity", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String)
    })
    const flow = Flow.make("IdentityGaps/ordinals", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String),
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* Activity.idempotencyKey("first-name")
          const second = yield* Activity.idempotencyKey("second-name")
          return [first, second] as const
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const [first, second] = yield* flow.execute({ id: "x" }, { executionId: "run-ordinals" })
      expect(first).not.toBe(second)
      // the name is diagnostic only: identity is (runId, ordinal, tier)
      expect(first).toBe(invocationKey("run-ordinals", 1))
      expect(second).toBe(invocationKey("run-ordinals", 2))
    }).pipe(Effect.provide(layer))
  })

  effect("scopes the key by the current attempt only when includeAttempt is set", () => {
    const flowActivityDeclaration = Activity.make("IdentityGaps/include-attempt/activity", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String)
    })
    const flow = Flow.make("IdentityGaps/include-attempt", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String),
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const plain = yield* Activity.idempotencyKey("op")
          const scoped = yield* Activity.idempotencyKey("op", { includeAttempt: true })
          const off = yield* Activity.idempotencyKey("op", { includeAttempt: false })
          return [plain, scoped, off] as const
        }).pipe(Effect.provideService(Activity.CurrentAttempt, 7))
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const [plain, scoped, off] = yield* flow.execute({ id: "x" }, { executionId: "run-attempt" })
      expect(plain).toBe(invocationKey("run-attempt", 1))
      // Each parent scope owns its own counter (issue #98), so the
      // attempt-scoped allocation numbers from 1 within `attempt:7`.
      expect(scoped).toBe(invocationKey("run-attempt", 1, "attempt:7"))
      // includeAttempt: false is identical in shape to omitting the option
      // and draws from the same unscoped counter as `plain`.
      expect(off).toBe(invocationKey("run-attempt", 2))
    }).pipe(Effect.provide(layer))
  })

  effect("an explicit parentScope wins over includeAttempt", () => {
    const flowActivityDeclaration = Activity.make("IdentityGaps/parent-scope/activity", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("IdentityGaps/parent-scope", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() =>
        Activity.idempotencyKey("op", { parentScope: "queue:orders", includeAttempt: true }).pipe(
          Effect.provideService(Activity.CurrentAttempt, 4)
        )
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const key = yield* flow.execute({ id: "x" }, { executionId: "run-scope" })
      expect(key).toBe(invocationKey("run-scope", 1, "queue:orders"))
      expect(key).not.toBe(invocationKey("run-scope", 1, "attempt:4"))
    }).pipe(Effect.provide(layer))
  })

  effect("keys allocated under the same attempt scope stay distinct per ordinal", () => {
    const flowActivityDeclaration = Activity.make("IdentityGaps/same-scope/activity", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String)
    })
    const flow = Flow.make("IdentityGaps/same-scope", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String),
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const a = yield* Activity.idempotencyKey("op", { includeAttempt: true })
          const b = yield* Activity.idempotencyKey("op", { includeAttempt: true })
          return [a, b] as const
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const [a, b] = yield* flow.execute({ id: "x" }, { executionId: "run-same" })
      expect(a).not.toBe(b)
      // CurrentAttempt defaults to 1 when nothing provides it
      expect(a).toBe(invocationKey("run-same", 1, "attempt:1"))
      expect(b).toBe(invocationKey("run-same", 2, "attempt:1"))
    }).pipe(Effect.provide(layer))
  })

  effect("keys with distinct parent scopes survive a replay with reversed arrival order (issue #98)", () => {
    // Two concurrent `DurableQueue.offer`-style allocations each declare
    // their payload key as `parentScope`. A run-global counter numbered them
    // in fiber-arrival order, so a replay whose interleaving reversed the
    // arrivals handed payload A payload B's ordinal — a brand-new key the
    // persisted queue had never seen, duplicating the work item and leaving
    // the original await watching a deferred nothing resolves. With the
    // counter scoped per declared parent, arrival order is immaterial.
    const flowActivityDeclaration = Activity.make("IdentityGaps/arrival-order/activity", {
      payload: { order: Schema.Array(Schema.String) },
      success: Schema.Record(Schema.String, Schema.String)
    })
    const flow = Flow.make("IdentityGaps/arrival-order", {
      payload: { order: Schema.Array(Schema.String) },
      success: Schema.Record(Schema.String, Schema.String),
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(({ order }) =>
        Effect.gen(function*() {
          const keys: Record<string, string> = {}
          for (const parent of order) {
            keys[parent] = yield* Activity.idempotencyKey("offer", { parentScope: parent })
          }
          return keys
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const first = yield* flow.execute(
        { order: ["payload:a", "payload:b"] },
        { executionId: "run-arrival-1" }
      )
      const replay = yield* flow.execute(
        { order: ["payload:b", "payload:a"] },
        { executionId: "run-arrival-2" }
      )
      expect(first["payload:a"]).toBe(invocationKey("run-arrival-1", 1, "payload:a"))
      expect(first["payload:b"]).toBe(invocationKey("run-arrival-1", 1, "payload:b"))
      // Identity is a function of the declared parent alone, never of which
      // fiber happened to allocate first.
      expect(replay["payload:a"]).toBe(invocationKey("run-arrival-2", 1, "payload:a"))
      expect(replay["payload:b"]).toBe(invocationKey("run-arrival-2", 1, "payload:b"))
    }).pipe(Effect.provide(layer))
  })
})

describe("infrastructure interrupt retry", () => {
  effect("passes a non-infrastructure failure through untouched instead of dying", () => {
    // The `while: isInfraInterrupt` retry wrapper must not convert an ordinary
    // typed failure into a defect just because a policy is installed.
    let attempts = 0
    const activity = Activity.make({
      name: "IdentityGaps/typed-failure",
      error: Schema.String,
      interruptRetryPolicy: Schedule.recurs(3),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("business-error")
      })
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("business-error")
      // a typed failure is never retried by the infra-interrupt policy
      expect(attempts).toBe(1)
    }).pipe(provideHost)
  })

  effect("retries an infrastructure interrupt until the policy is exhausted, then dies", () => {
    let attempts = 0
    const activity = Activity.make({
      name: "IdentityGaps/infra-exhausted",
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
      })
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        "infrastructure interrupt retry attempts exhausted"
      )
      // initial attempt + 2 recurrences
      expect(attempts).toBe(3)
    }).pipe(provideHost)
  })

  effect("recovers when a retried infrastructure interrupt later succeeds", () => {
    let attempts = 0
    const activity = Activity.make({
      name: "IdentityGaps/infra-recovers",
      success: Schema.Number,
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(5),
      execute: Effect.suspend(() => {
        attempts++
        return attempts < 3
          ? Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
          : Effect.succeed(attempts)
      })
    })

    return Effect.gen(function*() {
      expect(yield* activity.execute).toBe(3)
    }).pipe(provideHost)
  })

  effect("without a policy an infrastructure interrupt surfaces as its own typed failure", () => {
    const activity = Activity.make({
      name: "IdentityGaps/infra-unpolicied",
      error: Schema.Unknown,
      execute: Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(
        Exit.isFailure(exit) && (Cause.squash(exit.cause) as Activity.InfraInterrupt)._tag
      ).toBe("@smthrs/engine/InfraInterrupt")
    }).pipe(provideHost)
  })
})
