import { Journal } from "@smthrs/journal-next"
import { Jj } from "@smthrs/kernel-next"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store-next"
import { CacheStore } from "@smthrs/step-cache-next"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as ActivityPersistence from "../src/internal/ActivityPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "tiers", pid: 1, nonce: "owner" }

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const pending = yield* runs.get(runId)
    const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") {
      return yield* Effect.die(new Error(`run ${runId} claim was lost`))
    }
    yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
  })

const jjLayer = (snapshots: Array<string>, restores: Array<string>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () =>
        Effect.sync(() => {
          const changeId = `snapshot-${snapshots.length}`
          snapshots.push(changeId)
          return { changeId: changeId as never }
        }),
      restore: (changeId) =>
        Effect.sync(() => {
          restores.push(changeId as string)
        }),
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  )

describe("engine-store activity tiers", () => {
  it("replays a sealed activity from the shared cache across runs without dispatching again", async () => {
    let executions = 0
    const program = Effect.gen(function*() {
      yield* activate("sealed-first")
      const first = ActivityPersistence.make({
        runId: "sealed-first",
        owner,
        sourceId: "tier-test",
        execute: () => Effect.sync(() => ++executions)
      })({
        activity: {},
        attempt: 1,
        key: "caller-key/sealed",
        tier: "sealed",
        metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" }
      })
      yield* first
      yield* activate("sealed-second")
      const second = yield* ActivityPersistence.make({
        runId: "sealed-second",
        owner,
        sourceId: "tier-test",
        execute: () => Effect.sync(() => ++executions)
      })({
        activity: {},
        attempt: 1,
        key: "caller-key/sealed",
        tier: "sealed",
        metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" }
      })
      return second
    }).pipe(
      Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer([], []))),
      Effect.scoped
    )

    expect(await runPromise(program)).toBe(1)
    expect(executions).toBe(1)
  })

  it("persists compensable snapshot evidence and restores it before a retry without populating the cache", async () => {
    const snapshots: Array<string> = []
    const restores: Array<string> = []
    let executions = 0
    const program = Effect.gen(function*() {
      yield* activate("compensable")
      const execute = () => Effect.sync(() => ++executions)
      const runner = ActivityPersistence.make({ runId: "compensable", owner, sourceId: "tier-test", execute })
      yield* runner({ activity: {}, attempt: 1, key: "caller-key/compensable", tier: "compensable" })
      yield* runner({ activity: {}, attempt: 2, key: "caller-key/compensable", tier: "compensable" })
      const attempts = yield* AttemptStore.AttemptStore
      const cache = yield* CacheStore.CacheStore
      return {
        retry: yield* attempts.get({
          runId: "compensable",
          stepKeyDigest: sha256("caller-key/compensable"),
          attempt: 2
        }),
        cached: yield* cache.get(sha256("caller-key/compensable"))
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer(snapshots, restores))),
      Effect.scoped
    )

    const result = await runPromise(program)
    expect(executions).toBe(2)
    expect(snapshots).toEqual(["snapshot-0", "snapshot-1"])
    expect(restores).toEqual(["snapshot-0"])
    expect(Option.getOrThrow(result.retry).meta).toMatchObject({ snapshotId: "snapshot-1", tier: "compensable" })
    expect(Option.isNone(result.cached)).toBe(true)
  })

  it("requires an idempotency key before retrying an irreversible activity", async () => {
    const program = Effect.gen(function*() {
      yield* activate("irreversible")
      const withoutKey = ActivityPersistence.make({
        runId: "irreversible",
        owner,
        sourceId: "tier-test",
        execute: () => Effect.succeed("never")
      })({ activity: {}, attempt: 2, key: "caller-key/irreversible", tier: "irreversible" }).pipe(Effect.result)
      const withKey = yield* ActivityPersistence.make({
        runId: "irreversible",
        owner,
        sourceId: "tier-test",
        idempotencyKey: "request-1",
        execute: () => Effect.succeed("once")
      })({ activity: {}, attempt: 2, key: "caller-key/irreversible-keyed", tier: "irreversible" })
      return { withoutKey: yield* withoutKey, withKey }
    }).pipe(
      Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer([], []))),
      Effect.scoped
    )

    const result = await runPromise(program)
    expect(result.withoutKey).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "flows/engine-store/IrreversibleRetryRequiresIdempotencyKey" }
    })
    expect(result.withKey).toBe("once")
  })

  it("fails closed for hard undeclared writes, journals expected deviations, and never derives keys", async () => {
    const hard = Effect.gen(function*() {
      yield* activate("hard")
      return yield* ActivityPersistence.make({
        runId: "hard",
        owner,
        sourceId: "tier-test",
        execute: () => Effect.succeed("value")
      })({
        activity: {},
        attempt: 1,
        key: "supplier-key/hard",
        tier: "sealed",
        metadata: { readSet: [], writeSet: ["declared"], boundaryMode: "hard" }
      }).pipe(Effect.result)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest({ changedPaths: ["other"] }), jjLayer([], []))
      ),
      Effect.scoped
    )
    expect(await runPromise(hard)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "flows/engine-store/UndeclaredWrite" }
    })

    const expected = Effect.gen(function*() {
      yield* activate("expected")
      yield* ActivityPersistence.make({
        runId: "expected",
        owner,
        sourceId: "tier-test",
        execute: () => Effect.succeed("value")
      })({
        activity: {},
        attempt: 1,
        key: "supplier-key/expected",
        tier: "sealed",
        metadata: { readSet: [], writeSet: ["declared"], boundaryMode: "expected" }
      })
      const journal = yield* Journal.Journal
      const cache = yield* CacheStore.CacheStore
      yield* journal.flush
      return {
        events: yield* journal.entries({ runId: "expected" as never, limit: 20 }),
        cached: yield* cache.get(sha256("supplier-key/expected"))
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest({ changedPaths: ["other"] }), jjLayer([], []))
      ),
      Effect.scoped
    )
    const result = await runPromise(expected)
    expect(result.events.entries.map((entry) => entry.eventType)).toContain("flows.engine.expected-set-deviation")
    expect(Option.isNone(result.cached)).toBe(true)
  })
})
