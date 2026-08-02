/**
 * Issue #129: the `cacheSource("recorded")` producer identity was a constant
 * per key, so when a run evicted a stale row and re-recorded a fresh result
 * under the same key, the second `cacheProvenance` emit collapsed into a
 * `Duplicate` whose receipt returned the ORIGINAL emission's seq — the fresh
 * cache row was persisted with the evicted generation's exact
 * `(recordedRunId, recordedEventSeq)`. A laggard dispatch still holding
 * pre-eviction provenance then passed the #119 `ifRecordedBy` CAS and
 * deleted the valid new row. The producer identity now folds a digest of the
 * recorded content, so a re-record with different content is a distinct
 * generation with fresh provenance, while the #124 convergence re-record
 * (identical content) still collapses into a `Duplicate`.
 */
import { CacheStore, Journal, type Ownership, RunStore } from "@smithers/journal"
import * as TestJournal from "@smithers/journal/test/TestJournal"
import { Jj } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as ActivityPersistence from "../src/internal/ActivityPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const owner: Ownership.OwnerId = { hostId: "generation-host", pid: 29, nonce: "generation-process" }

const declared: ActivityPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "generation-snapshot" as never }),
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

/**
 * A boundary whose `prepare` answers from a queue of measured read
 * snapshots: the cache-hit verification sees the first measurement, the
 * dispatch path's re-prepare sees the next. This models the #129 window —
 * the hit verification measures a changed file (stale read set → fenced
 * evict), the re-execution measures content matching the declaration again,
 * so its fresh completion is recorded under the same key.
 */
const flappingBoundary = (measurements: Array<ReadonlyArray<StepBoundary.ReadSetEntry>>) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) =>
        Effect.sync(() => ({
          descriptor,
          readSnapshot: measurements.length > 1 ? measurements.shift()! : measurements[0]!
        })),
      settle: (prepared) =>
        Effect.succeed({
          declaredOutputs: { paths: prepared.descriptor.writeSet },
          diffIdentity: "generation-diff"
        }),
      replayOutputs: () => Effect.void
    })
  )

describe("post-eviction re-records take fresh provenance (issue #129)", () => {
  it("stamps a re-recorded generation with its own event seq so the evicted fence cannot delete it", async () => {
    const runId = "generation-run"
    const key = "generation/evict-re-record"
    const keyDigest = Digest.digest(key)
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate(runId)
        const execute = (result: string, attempt: number, boundary: Layer.Layer<StepBoundary.Service>) =>
          ActivityPersistence.make({
            runId,
            owner,
            sourceId: `generation-${runId}`,
            execute: () => Effect.succeed(result)
          })({ activity: {}, attempt, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(boundary)
          )
        // Generation 0: records the row under a healthy measurement.
        yield* execute("recorded", 1, flappingBoundary([declared.readSet as never]))
        const generation0 = yield* cache.get(keyDigest)
        if (Option.isNone(generation0)) return yield* Effect.die(new Error("generation 0 missing"))
        // Generation 1, same run: the hit verification measures a stale read
        // set (fenced evict of generation 0), the re-execution's prepare
        // measures the declaration again and records a DIFFERENT result.
        const second = yield* execute(
          "regenerated",
          2,
          flappingBoundary([
            [{ path: "config.json", digest: "D2" }],
            declared.readSet as never
          ])
        )
        const generation1 = yield* cache.get(keyDigest)
        if (Option.isNone(generation1)) return yield* Effect.die(new Error("generation 1 missing"))
        // A laggard still holding generation 0's provenance must no-op.
        const laggardDeleted = yield* cache.evict(keyDigest, {
          ifRecordedBy: {
            runId: generation0.value.recordedRunId,
            eventSeq: generation0.value.recordedEventSeq
          }
        })
        const survivor = yield* cache.get(keyDigest)
        return {
          second,
          generation0: generation0.value,
          generation1: generation1.value,
          laggardDeleted,
          survivorPresent: Option.isSome(survivor)
        }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.second).toBe("regenerated")
    expect(outcome.generation1.result).toBe("regenerated")
    // The re-record is a NEW generation: it must not inherit the evicted
    // row's provenance through the journal's Duplicate receipt.
    expect(outcome.generation1.recordedEventSeq).not.toBe(outcome.generation0.recordedEventSeq)
    // And so the laggard's pre-eviction fence no longer matches anything.
    expect(outcome.laggardDeleted).toBe(false)
    expect(outcome.survivorPresent).toBe(true)
  })
})

describe("identical-content re-records collapse into the original provenance", () => {
  it("re-drives the #124 convergence re-record into a journal Duplicate with no new row (issue #140)", async () => {
    // The other half of the #129 contract: a crash between the provenance
    // emit and `cache.put` converges on the next dispatch by re-recording
    // the SAME content rebuilt from the persisted attempt row. That
    // re-record must collapse into a journal `Duplicate` — the producer
    // identity digest over `{ meta, result }` must be byte-stable across
    // the DB round-trip of `row.meta` — or every convergence appends a
    // fresh `cacheProvenance` row forever.
    const runId = "generation-convergence"
    const key = "generation/convergence-duplicate"
    const keyDigest = Digest.digest(key)
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        const journal = yield* Journal.Journal
        yield* activate(runId)
        const execute = ActivityPersistence.make({
          runId,
          owner,
          sourceId: `generation-${runId}`,
          execute: () => Effect.succeed("recorded")
        })
        const dispatch = execute({ activity: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: declared.readSet }))
        )
        yield* dispatch
        const original = yield* cache.get(keyDigest)
        if (Option.isNone(original)) return yield* Effect.die(new Error("original row missing"))
        // Model the crash window: the provenance row is journalled but the
        // cache row is gone, so the next dispatch of the same attempt takes
        // the succeeded-row convergence branch and re-records.
        yield* cache.evict(keyDigest)
        const replayed = yield* dispatch
        const converged = yield* cache.get(keyDigest)
        if (Option.isNone(converged)) return yield* Effect.die(new Error("converged row missing"))
        yield* journal.flush
        const page = yield* journal.entries({ runId: runId as never, limit: 100 })
        const recorded = page.entries.filter((entry) =>
          entry.eventType === "flows.engine.cache-provenance" &&
          (entry.payload as { readonly action?: string }).action === "recorded"
        )
        return { replayed, original: original.value, converged: converged.value, recorded }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.replayed).toBe("recorded")
    // The identical-content re-record collapsed into a Duplicate: exactly
    // one recorded row in the journal, and the converged cache row carries
    // the ORIGINAL emission's canonical provenance.
    expect(outcome.recorded).toHaveLength(1)
    expect(outcome.converged.recordedEventSeq).toBe(outcome.original.recordedEventSeq)
    expect(outcome.converged.recordedRunId).toBe(outcome.original.recordedRunId)
  })
})
