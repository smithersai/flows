/**
 * Issue #150: every `replayOutputs` failure — including a digest mismatch at
 * the content-addressed blob path, an integrity violation of the store's
 * strongest invariant — was journalled as one undifferentiated
 * `replay_failed` provenance row and never routed to the Inconsistency
 * receiver, so a failing disk corrupting many blobs looked identical to a
 * one-off transient EIO. Materialization failures are now classified once:
 * a `BoundaryCorruption` routes to `Inconsistency.noteCorruption` (core
 * default STRICT — the dispatch fails with `CacheCorruptionDetected`; a
 * tolerant receiver lets it fall back to the healing re-execution), while
 * transient host errors stay retryable and never reach the receiver. Both
 * classes journal their `reason` on the `replay_failed` provenance record.
 */
import { CacheStore, Journal, type Ownership, RunStore } from "@smithers/journal"
import * as TestJournal from "@smithers/journal/test/TestJournal"
import { Jj } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActivityPersistence from "../src/internal/ActivityPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const owner: Ownership.OwnerId = { hostId: "corruption-host", pid: 91, nonce: "corruption-process" }

const declared: ActivityPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["dist/manifest.json"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "corruption-snapshot" as never }),
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
  ActivityPersistence.make({ runId, owner, sourceId: `corruption-${runId}`, execute })({
    activity: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

const corruptionError = new StepBoundary.BoundaryCorruption({
  code: "boundary_corruption",
  path: "dist/manifest.json",
  recordedDigest: "aa".repeat(32),
  measuredDigest: "bb".repeat(32)
})

/** A boundary that verifies the read set but fails materialization with `error`. */
const failingReplay = (error: StepBoundary.UnsupportedBoundary | StepBoundary.BoundaryCorruption) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: descriptor.readSet }),
      settle: () => Effect.succeed({ declaredOutputs: { outputs: [] }, diffIdentity: "corruption-diff" }),
      replayOutputs: () => Effect.fail(error)
    })
  )

const records = (runId: string, eventType: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === eventType)
      .map((entry) => entry.payload as Record<string, unknown>)
  })

describe("replay-failed classification (issue #150)", () => {
  it("the noop receiver tolerates corruption by default", async () => {
    const verdict = await Effect.runPromise(
      Inconsistency.makeNoop().noteCorruption({
        runId: "noop-run",
        keyDigest: "noop-key",
        path: "dist/manifest.json",
        recordedDigest: "aa".repeat(32),
        measuredDigest: "bb".repeat(32)
      })
    )
    expect(verdict).toBe("tolerate")
  })

  it("routes blob corruption on a verified hit to the Inconsistency receiver and fails strictly by default", async () => {
    const key = "corruption/strict-hit"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        yield* activate("corruption-strict-first")
        yield* dispatch("corruption-strict-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(failingReplay(corruptionError))
        )
        yield* activate("corruption-strict-second")
        const failed = yield* dispatch("corruption-strict-second", key, () => Effect.die("must not execute")).pipe(
          Effect.provide(failingReplay(corruptionError)),
          Effect.flip
        )
        const provenance = yield* records("corruption-strict-second", "flows.engine.cache-provenance")
        const corruption = yield* records("corruption-strict-second", "flows.engine.cache-corruption")
        return { failed, provenance, corruption }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.failed).toBeInstanceOf(ActivityPersistence.CacheCorruptionDetected)
    const failure = outcome.failed as ActivityPersistence.CacheCorruptionDetected
    expect(failure.code).toBe("cache_corruption_detected")
    expect(failure.path).toBe("dist/manifest.json")
    // The refusal record names its class — never an undifferentiated row.
    const refused = outcome.provenance.find((payload) => payload.action === "replay_failed")
    expect(refused?.reason).toBe("corruption")
    // The corruption reached the receiver's durable journal channel.
    expect(outcome.corruption).toHaveLength(1)
    expect(outcome.corruption[0]).toMatchObject({
      keyDigest: Digest.digest(key),
      verdict: "fail",
      path: "dist/manifest.json",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "bb".repeat(32)
    })
  })

  it("falls back to the healing re-execution when the receiver tolerates corruption", async () => {
    const key = "corruption/tolerated-hit"
    const noted: Array<Inconsistency.BlobCorruption> = []
    const tolerant = Layer.succeed(Inconsistency.Inconsistency)(
      Inconsistency.makeNoop({
        noteCorruption: (event) =>
          Effect.sync(() => {
            noted.push(event)
            return "tolerate" as const
          })
      })
    )
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        yield* activate("corruption-tolerated-first")
        yield* dispatch("corruption-tolerated-first", key, body).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
        )
        yield* activate("corruption-tolerated-second")
        const second = yield* dispatch("corruption-tolerated-second", key, body).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
        )
        return { executions, second }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // The tolerated corruption is not a hit: the body re-executes for real.
    expect(outcome.second).toBe("recorded")
    expect(outcome.executions).toBe(2)
    expect(noted).toHaveLength(1)
    expect(noted[0]).toMatchObject({ keyDigest: Digest.digest(key), path: "dist/manifest.json" })
  })

  it("keeps transient host errors retryable and never routes them to the receiver", async () => {
    const key = "corruption/host-error"
    const hostError = new StepBoundary.UnsupportedBoundary({
      code: "unsupported_boundary",
      message: "EIO: transient host failure"
    })
    const noted: Array<Inconsistency.BlobCorruption> = []
    const watching = Layer.succeed(Inconsistency.Inconsistency)(
      Inconsistency.makeNoop({
        noteCorruption: (event) =>
          Effect.sync(() => {
            noted.push(event)
            return "fail" as const
          })
      })
    )
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        yield* activate("corruption-host-first")
        yield* dispatch("corruption-host-first", key, body).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(hostError), watching))
        )
        yield* activate("corruption-host-second")
        const second = yield* dispatch("corruption-host-second", key, body).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(hostError), watching))
        )
        const provenance = yield* records("corruption-host-second", "flows.engine.cache-provenance")
        return { executions, second, provenance }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // A transient refusal falls back to a real execution — even under a
    // receiver whose corruption verdict is "fail" — because it is not
    // corruption.
    expect(outcome.second).toBe("recorded")
    expect(outcome.executions).toBe(2)
    expect(noted).toHaveLength(0)
    const refused = outcome.provenance.find((payload) => payload.action === "replay_failed")
    expect(refused?.reason).toBe("host")
  })

  it("classifies corruption on a succeeded attempt's replay and fails strictly by default", async () => {
    const key = "corruption/succeeded-row"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("corruption-row")
        yield* dispatch("corruption-row", key, () => Effect.succeed("durable-outcome")).pipe(
          Effect.provide(failingReplay(corruptionError))
        )
        // Evicting the cache row routes the re-dispatch to the succeeded
        // attempt row's replay branch rather than the cache-hit gate.
        yield* cache.evict(Digest.digest(key))
        const failed = yield* dispatch("corruption-row", key, () => Effect.die("must not re-execute")).pipe(
          Effect.provide(failingReplay(corruptionError)),
          Effect.flip
        )
        const provenance = yield* records("corruption-row", "flows.engine.cache-provenance")
        const corruption = yield* records("corruption-row", "flows.engine.cache-corruption")
        return { failed, provenance, corruption }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.failed).toBeInstanceOf(ActivityPersistence.CacheCorruptionDetected)
    const refused = outcome.provenance.find((payload) => payload.action === "replay_failed")
    expect(refused?.reason).toBe("corruption")
    // Attempt-row evidence carries no cache provenance; the record says so
    // explicitly instead of inventing one.
    expect(outcome.corruption).toHaveLength(1)
    expect(outcome.corruption[0]).toMatchObject({ recordedRunId: null, recordedEventSeq: null })
  })

  it("returns the durable outcome when a tolerant receiver accepts succeeded-row corruption", async () => {
    const key = "corruption/succeeded-tolerated"
    const tolerant = Inconsistency.layerTolerant
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("corruption-row-tolerated")
        yield* dispatch("corruption-row-tolerated", key, () => Effect.succeed("durable-outcome")).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
        )
        yield* cache.evict(Digest.digest(key))
        return yield* dispatch("corruption-row-tolerated", key, () => Effect.die("must not re-execute")).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), tolerant))
        )
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // The attempt durably succeeded: under a tolerant verdict its recorded
    // outcome remains the truth.
    expect(outcome).toBe("durable-outcome")
  })

  it("quarantines tolerated succeeded-row corruption instead of converging it into the shared cache (issue #160)", async () => {
    const key = "corruption/succeeded-quarantined"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("corruption-quarantine")
        yield* dispatch("corruption-quarantine", key, () => Effect.succeed("durable-outcome")).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant))
        )
        // Route the re-dispatch to the succeeded-row branch, whose issue-#24
        // convergence block would republish the row.
        yield* cache.evict(Digest.digest(key))
        const replayed = yield* dispatch("corruption-quarantine", key, () => Effect.die("must not re-execute")).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant))
        )
        const cached = yield* cache.get(Digest.digest(key))
        return { replayed, cached }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // The durable outcome is still the truth for this run…
    expect(outcome.replayed).toBe("durable-outcome")
    // …but evidence just measured corrupt never converges into the shared
    // cache for sibling runs: the row is quarantined, not recorded.
    expect(Option.isNone(outcome.cached)).toBe(true)
  })

  it("converges an idempotency conflict on the corruption record but propagates other journal failures", async () => {
    // The dedupe identity (issue #156) makes a cross-lineage duplicate an
    // `idempotency_conflict` — the evidence already exists, so the receiver
    // still returns its verdict. Any other journal failure is real.
    const event = {
      runId: "dedupe-conflict",
      keyDigest: "k",
      path: "dist/manifest.json",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "bb".repeat(32)
    }
    const failing = (code: "idempotency_conflict" | "fence_lost") =>
      Inconsistency.make({
        journal: Journal.makeNoop({
          emitDurable: () => Effect.fail(new Journal.JournalError({ code, message: code }))
        }),
        verdict: "fail"
      })
    const converged = await Effect.runPromise(failing("idempotency_conflict").noteCorruption(event))
    expect(converged).toBe("fail")
    const propagated = await Effect.runPromise(Effect.flip(failing("fence_lost").noteCorruption(event)))
    expect(propagated).toMatchObject({ code: "fence_lost" })
  })

  it("evicts the poisoned row on detected corruption so the next dispatch re-executes cleanly (issue #164)", async () => {
    // Quarantine is journal AND evict: routing to the receiver without
    // removing the row left inline-corrupt evidence in place forever —
    // `CacheStore.put` is insert-or-nothing, so strict mode re-failed every
    // later run on the key and tolerant mode re-detected and re-executed
    // with no heal possible.
    const key = "corruption/quarantine-evicts"
    const healthyReplay = Layer.succeed(
      StepBoundary.StepBoundary,
      StepBoundary.make({
        prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: descriptor.readSet }),
        settle: () => Effect.succeed({ declaredOutputs: { outputs: [] }, diffIdentity: "corruption-diff" }),
        replayOutputs: () => Effect.void
      })
    )
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("corruption-evict-first")
        yield* dispatch("corruption-evict-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(failingReplay(corruptionError))
        )
        yield* activate("corruption-evict-second")
        const failed = yield* dispatch("corruption-evict-second", key, () => Effect.die("must not execute")).pipe(
          Effect.provide(failingReplay(corruptionError)),
          Effect.flip
        )
        const evicted = yield* cache.get(Digest.digest(key))
        // The same key dispatched again — with a healthy boundary — must be
        // an ordinary miss that re-executes and re-records cleanly, not a
        // re-detection of the quarantined row.
        yield* activate("corruption-evict-third")
        let executions = 0
        const healed = yield* dispatch("corruption-evict-third", key, () =>
          Effect.sync(() => {
            executions++
            return "healed"
          })).pipe(Effect.provide(healthyReplay))
        const recorded = yield* cache.get(Digest.digest(key))
        return { failed, evicted, healed, executions, recorded }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.failed).toBeInstanceOf(ActivityPersistence.CacheCorruptionDetected)
    expect(Option.isNone(outcome.evicted)).toBe(true)
    expect(outcome.healed).toBe("healed")
    expect(outcome.executions).toBe(1)
    expect(Option.isSome(outcome.recorded)).toBe(true)
  })

  it("replaces the poisoned row when a tolerant receiver falls back to re-execution (issue #164)", async () => {
    const key = "corruption/quarantine-replaces"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("corruption-replace-first")
        yield* dispatch("corruption-replace-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant))
        )
        yield* activate("corruption-replace-second")
        yield* dispatch("corruption-replace-second", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(Layer.mergeAll(failingReplay(corruptionError), Inconsistency.layerTolerant))
        )
        return yield* cache.get(Digest.digest(key))
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    // Without the evict, `CacheStore.put`'s insert-or-nothing left the first
    // run's corrupt row in place; the healing re-execution must own the row.
    expect(Option.isSome(outcome)).toBe(true)
    expect(Option.map(outcome, (entry) => entry.recordedRunId)).toEqual(Option.some("corruption-replace-second"))
  })

  it("journals distinct corruptions of the same key as distinct records (issue #167)", async () => {
    // The dedupe cell alone is satisfiable by a constant identity: a
    // regression dropping the digest/path interpolation from the producer
    // identity would still journal "exactly once" while silently swallowing
    // genuinely different corruption evidence through the converging
    // idempotency-conflict branch. Two observations of the SAME key whose
    // measured evidence differs must each land durably.
    const key = "corruption/distinct-records"
    const secondCorruption = new StepBoundary.BoundaryCorruption({
      code: "boundary_corruption",
      path: "dist/manifest.json",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "cc".repeat(32)
    })
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("corruption-distinct-first")
        yield* dispatch("corruption-distinct-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(failingReplay(corruptionError))
        )
        yield* activate("corruption-distinct-second")
        const poisoned = yield* cache.get(Digest.digest(key))
        if (Option.isNone(poisoned)) return yield* Effect.die(new Error("row missing"))
        for (const error of [corruptionError, secondCorruption]) {
          yield* dispatch("corruption-distinct-second", key, () => Effect.die("must not execute")).pipe(
            Effect.provide(failingReplay(error)),
            Effect.flip
          )
          yield* cache.put(poisoned.value)
        }
        return yield* records("corruption-distinct-second", "flows.engine.cache-corruption")
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome).toHaveLength(2)
    expect(outcome.map((payload) => payload.measuredDigest).sort()).toEqual([
      "bb".repeat(32),
      "cc".repeat(32)
    ])
  })

  it("journals a repeated identical corruption exactly once (issue #156)", async () => {
    const key = "corruption/deduped-record"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        yield* activate("corruption-dedupe-first")
        yield* dispatch("corruption-dedupe-first", key, () => Effect.succeed("recorded")).pipe(
          Effect.provide(failingReplay(corruptionError))
        )
        yield* activate("corruption-dedupe-second")
        // The same corrupt evidence observed twice — since issue #164 each
        // detection evicts the row, so the second observation models the
        // cross-process race in which a sibling re-records the identical
        // corrupt row between detections. Neither observation may append a
        // second durable corruption record: the producer identity is the
        // content key, so the re-emission collapses into a journal duplicate.
        const cache = yield* CacheStore.CacheStore
        const poisoned = yield* cache.get(Digest.digest(key))
        if (Option.isNone(poisoned)) return yield* Effect.die(new Error("row missing"))
        for (let attempt = 1; attempt <= 2; attempt++) {
          yield* ActivityPersistence.make({
            runId: "corruption-dedupe-second",
            owner,
            sourceId: "corruption-corruption-dedupe-second",
            execute: () => Effect.die("must not execute")
          })({
            activity: {},
            // The attempt number varies across the two observations (issue
            // #168): folding it into either durable identity would restore
            // per-attempt journal growth while a constant-attempt cell
            // stayed green.
            attempt,
            key,
            tier: "sealed",
            metadata: declared
          }).pipe(
            Effect.provide(failingReplay(corruptionError)),
            Effect.flip
          )
          yield* cache.put(poisoned.value)
        }
        return {
          corruption: yield* records("corruption-dedupe-second", "flows.engine.cache-corruption"),
          provenance: yield* records("corruption-dedupe-second", "flows.engine.cache-provenance")
        }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.corruption).toHaveLength(1)
    // Both per-attempt durable rows converge, not just the corruption record
    // (issue #168): the replay-refusal provenance identity is
    // per-(key, action, recorded-provenance), so the varying attempt above
    // must not multiply `replay_failed` rows either.
    expect(outcome.provenance.filter((payload) => payload.action === "replay_failed")).toHaveLength(1)
  })
})
