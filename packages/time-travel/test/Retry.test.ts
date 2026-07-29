import * as Jj from "@flows/host/Jj"
import { CacheStore } from "@flows/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import type { EffectRecord, EffectTier } from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/EffectHandlerRegistry.ts"
import * as Retry from "../src/Retry.ts"

const crossed = (
  tier: EffectTier,
  overrides: Partial<EffectRecord> = {}
): EffectRecord => ({
  id: `${tier}-effect`,
  kind: tier === "irreversible" ? "mail.send" : tier,
  tier,
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  seq: 5,
  durableBoundary: true,
  providerStream: true,
  ...overrides
})

const handler: EffectHandlerRegistry.Handler = {
  kind: "mail.send",
  tier: "irreversible",
  requiresIdempotencyKey: true,
  residue: () => "mail residue",
  revert: () => Effect.succeed("receipt"),
  rollback: () => Effect.void
}

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  cache: CacheStore.Service,
  jj: Jj.Jj
) =>
  program.pipe(
    Effect.provide(Layer.succeed(CacheStore.CacheStore, cache)),
    Effect.provide(Layer.succeed(Jj.Jj, jj)),
    Effect.provide(
      Layer.succeed(
        EffectHandlerRegistry.EffectHandlerRegistry,
        Effect.runSync(EffectHandlerRegistry.make([handler]))
      )
    )
  )

const cache = (
  value: Option.Option<CacheStore.CacheEntry>
): CacheStore.Service => CacheStore.makeNoop({ get: () => Effect.succeed(value) })

const jj = (
  onRestore: (changeId: string) => void = () => {}
): Jj.Jj =>
  Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: "current" }),
    restore: (changeId) => Effect.sync(() => onRestore(changeId))
  })

describe("Retry", () => {
  it("returns a sealed cache hit without invoking the producer", async () => {
    let reruns = 0
    const entry: CacheStore.CacheEntry = {
      keyDigest: "cache-key",
      result: { answer: 42 },
      meta: {},
      createdAtMs: 0,
      recordedRunId: "run",
      recordedEventSeq: 5
    }
    const result = await Effect.runPromise(
      provide(
        Retry.retry({
          effect: crossed("sealed", { cacheKey: "cache-key" }),
          previousAttempt: 1,
          previousNonce: "poison",
          makeNonce: () => Effect.succeed("fresh"),
          rerun: () =>
            Effect.sync(() => {
              reruns += 1
              return "rerun"
            })
        }),
        cache(Option.some(entry)),
        jj()
      )
    )

    expect(result).toEqual({
      _tag: "CacheHit",
      value: { answer: 42 },
      attempt: 2,
      nonce: "fresh"
    })
    expect(reruns).toBe(0)
  })

  it("rejects a byte-identical poison pill with a new attempt and nonce", async () => {
    const contexts: Array<Retry.AttemptContext> = []
    const result = await Effect.runPromise(
      provide(
        Retry.retry({
          effect: crossed("sealed", { cacheKey: "missing" }),
          previousAttempt: 7,
          previousNonce: "poison",
          makeNonce: () => Effect.succeed("poison"),
          rerun: (context) =>
            Effect.sync(() => {
              contexts.push(context)
              return "ok"
            })
        }),
        cache(Option.none()),
        jj()
      )
    )

    expect(result._tag).toBe("Rerun")
    expect(contexts).toEqual([{
      attempt: 8,
      nonce: "poison:retry:8",
      restartAt: "durable-boundary",
      resumeProviderStream: false
    }])
  })

  it("restores the recorded jj snapshot before a compensable rerun", async () => {
    const order: Array<string> = []
    const result = await Effect.runPromise(
      provide(
        Retry.retry({
          effect: crossed("compensable", { changeId: "before-attempt" }),
          previousAttempt: 2,
          previousNonce: "old",
          makeNonce: () => Effect.succeed("new"),
          rerun: () =>
            Effect.sync(() => {
              order.push("rerun")
              return "ok"
            })
        }),
        cache(Option.none()),
        jj((changeId) => order.push(`restore:${changeId}`))
      )
    )

    expect(result._tag).toBe("Rerun")
    expect(order).toEqual(["restore:before-attempt", "rerun"])
  })

  it("returns a typed outcome for an irreversible retry without an idempotency key", async () => {
    let reruns = 0
    const result = await Effect.runPromise(
      provide(
        Retry.retry({
          effect: crossed("irreversible"),
          previousAttempt: 1,
          previousNonce: "old",
          makeNonce: () => Effect.succeed("new"),
          rerun: () =>
            Effect.sync(() => {
              reruns += 1
              return "sent"
            })
        }),
        cache(Option.none()),
        jj()
      )
    )

    expect(result).toMatchObject({
      _tag: "Blocked",
      reason: "idempotency_key_required",
      attempt: 2,
      nonce: "new"
    })
    expect(reruns).toBe(0)
  })

  it("passes an irreversible idempotency key to the fresh attempt", async () => {
    const contexts: Array<Retry.AttemptContext> = []
    const result = await Effect.runPromise(
      provide(
        Retry.retry({
          effect: crossed("irreversible", { idempotencyKey: "mail:123" }),
          previousAttempt: 3,
          previousNonce: "old",
          makeNonce: () => Effect.succeed("new"),
          rerun: (context) =>
            Effect.sync(() => {
              contexts.push(context)
              return "sent"
            })
        }),
        cache(Option.none()),
        jj()
      )
    )

    expect(result._tag).toBe("Rerun")
    expect(contexts).toEqual([{
      attempt: 4,
      nonce: "new",
      idempotencyKey: "mail:123",
      restartAt: "durable-boundary",
      resumeProviderStream: false
    }])
  })

  it("never retries from a non-durable boundary", async () => {
    let reruns = 0
    const result = await Effect.runPromise(
      provide(
        Retry.retry({
          effect: crossed("sealed", { durableBoundary: false }),
          previousAttempt: 1,
          previousNonce: "old",
          makeNonce: () => Effect.succeed("new"),
          rerun: () =>
            Effect.sync(() => {
              reruns += 1
              return "bad"
            })
        }),
        cache(Option.none()),
        jj()
      )
    )

    expect(result).toMatchObject({
      _tag: "Blocked",
      reason: "not_durable_boundary"
    })
    expect(reruns).toBe(0)
  })
})
