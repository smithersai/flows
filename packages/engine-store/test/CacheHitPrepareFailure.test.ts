/**
 * Issue #110: a transient host filesystem error during cache-hit prepare was
 * collapsed by `Effect.option` into the same branch as a genuinely stale
 * read set, so a one-off EIO/EACCES journalled a factually wrong
 * `stale_read_set` record and destroyed a valid, expensively-computed shared
 * cache row every other run was legitimately reusing. A host that cannot
 * measure right now is not evidence the inputs changed: the hit is refused
 * for this dispatch only, the row survives, and the dispatch path's own
 * re-prepare surfaces the host failure as an ordinary retryable attempt
 * failure. Eviction is reserved for a measured mismatch, and it re-reads the
 * row's provenance first so a fresh entry recorded by a concurrent run
 * between the get and the evict is not deleted with the poison.
 */
import { CacheStore, Journal, type Ownership, RunStore } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Jj } from "@smthrs/kernel"
import { Digest } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as ActivityPersistence from "../src/internal/ActivityPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const owner: Ownership.OwnerId = { hostId: "prepare-failure-host", pid: 31, nonce: "prepare-failure-process" }

const declared: ActivityPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "prepare-failure-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>) =>
  ActivityPersistence.make({ runId, owner, sourceId: `prepare-failure-${runId}`, execute })({
    activity: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

const provenance = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string })
  })

describe("transient prepare host errors on a cache hit (issue #110)", () => {
  it("keeps the valid row, journals no stale_read_set, and fails the attempt retryably", async () => {
    const key = "prepare-failure/transient"
    const keyDigest = Digest.digest(key)
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        // First run records the entry under a healthy boundary.
        yield* activate("prepare-transient-first")
        yield* dispatch("prepare-transient-first", key, body).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: declared.readSet }))
        )
        // Second run's host dies measuring the read set: every prepare —
        // the cache-hit gate and the dispatch path's own — fails.
        yield* activate("prepare-transient-second")
        const exit = yield* dispatch("prepare-transient-second", key, body).pipe(
          Effect.provide(StepBoundary.layerTest({ supported: false })),
          Effect.exit
        )
        const entry = yield* cache.get(keyDigest)
        const records = yield* provenance("prepare-transient-second")
        return { executions, exit, entry, records }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // The attempt fails as an ordinary host error the retry ladder owns…
    expect(outcome.exit._tag).toBe("Failure")
    // …the body never ran under the broken host…
    expect(outcome.executions).toBe(1)
    // …the valid shared row survives for every other run…
    expect(Option.isSome(outcome.entry)).toBe(true)
    // …and no factually wrong stale_read_set record was journalled.
    expect(outcome.records.map((record) => record.action)).not.toContain("stale_read_set")
  })

  it("a transient prepare failure refuses the hit, re-prepares, and runs the body (issue #126)", async () => {
    const key = "prepare-failure/transient-recovery"
    const keyDigest = Digest.digest(key)
    // The transient cell: prepare dies on its FIRST invocation (the
    // cache-hit gate's measurement) and returns a verified snapshot on
    // every later one (the dispatch path's own re-prepare).
    const transientBoundary = () => {
      let prepares = 0
      return Layer.succeed(
        StepBoundary.StepBoundary,
        StepBoundary.make({
          prepare: (descriptor) =>
            ++prepares === 1
              ? Effect.fail(
                new StepBoundary.UnsupportedBoundary({
                  code: "unsupported_boundary",
                  message: "transient EIO measuring the read set"
                })
              )
              : Effect.succeed({ descriptor, readSnapshot: descriptor.readSet }),
          settle: (prepared) =>
            Effect.succeed({
              declaredOutputs: { paths: prepared.descriptor.writeSet },
              diffIdentity: "transient-recovery-diff"
            }),
          replayOutputs: () => Effect.void
        })
      )
    }
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        yield* activate("prepare-transient-recovery-first")
        yield* dispatch("prepare-transient-recovery-first", key, body).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: declared.readSet }))
        )
        yield* activate("prepare-transient-recovery-second")
        const result = yield* dispatch("prepare-transient-recovery-second", key, body).pipe(
          Effect.provide(transientBoundary())
        )
        const entry = yield* cache.get(keyDigest)
        const records = yield* provenance("prepare-transient-recovery-second")
        return { result, executions, entry, records }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // The dispatch succeeds on the re-prepared real execution…
    expect(outcome.result).toBe("recorded")
    // …the cache-hit gate refused (never replayed) and the body ran again…
    expect(outcome.executions).toBe(2)
    // …the valid shared row survives…
    expect(Option.isSome(outcome.entry)).toBe(true)
    // …and no factually wrong stale_read_set record was journalled.
    expect(outcome.records.map((record) => record.action)).not.toContain("stale_read_set")
  })

  it("a genuinely stale measurement still journals stale_read_set and evicts", async () => {
    const key = "prepare-failure/still-stale"
    const keyDigest = Digest.digest(key)
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("prepare-stale-first")
        yield* dispatch("prepare-stale-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: declared.readSet }))
        )
        yield* activate("prepare-stale-second")
        yield* dispatch("prepare-stale-second", key, () => Effect.succeed("fresh")).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] }))
        )
        const entry = yield* cache.get(keyDigest)
        const records = yield* provenance("prepare-stale-second")
        return { entry, records }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.records.map((record) => record.action)).toContain("stale_read_set")
    // The poisoned row was invalidated (the re-execution recorded nothing
    // new here: its declaration still mismatches the measured set). The
    // strong form: the row is gone, not merely different — the old
    // disjunction also passed if the evict silently failed and the row was
    // replaced (issue #127).
    expect(Option.isNone(outcome.entry)).toBe(true)
  })

  it("skips the evict when a concurrent run re-recorded the entry between get and evict", async () => {
    const key = "prepare-failure/concurrent-put"
    const keyDigest = Digest.digest(key)
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("prepare-race-first")
        yield* dispatch("prepare-race-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: declared.readSet }))
        )
        // A racing dispatch observes the first row, decides it is stale, and
        // — between its `get` and its `evict` — a *foreign process* replaces
        // the entry. The per-key admission permit cannot close that window
        // (issue #119), so the fencing predicate inside the DELETE is what
        // protects the fresh row: the interceptor lands the replacement
        // immediately before the eviction reaches the store.
        yield* activate("prepare-race-second")
        const swapping: typeof cache = {
          put: (entry) => cache.put(entry),
          get: (digest) => cache.get(digest),
          evict: (digest, options) =>
            Effect.gen(function*() {
              // The concurrent run's fresh entry lands before the delete.
              yield* cache.evict(digest)
              yield* cache.put({
                keyDigest: digest,
                result: "fresh-from-concurrent-run",
                meta: { tier: "sealed" },
                createdAtMs: 99,
                recordedRunId: "concurrent-run",
                recordedEventSeq: 9
              })
              return yield* cache.evict(digest, options)
            })
        }
        const exit = yield* dispatch("prepare-race-second", key, () => Effect.succeed("fresh")).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] })),
          Effect.provideService(CacheStore.CacheStore, swapping),
          Effect.exit
        )
        const entry = yield* cache.get(keyDigest)
        return { exit, entry }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // The concurrent run's fresh entry survives the racing evict.
    expect(Option.isSome(outcome.entry)).toBe(true)
    if (Option.isSome(outcome.entry)) {
      expect(outcome.entry.value.recordedRunId).toBe("concurrent-run")
    }
  })
})
