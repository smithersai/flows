/**
 * Rebuild/conformance suite for the step-cache fold: at every commit the
 * materialized tables must equal the fold of the retained journal, so
 * truncating them and replaying must land byte-equal rows across insert,
 * duplicate, conflict, eviction, and provenance paths — and a refused write
 * must append nothing. `docs/specs/Concepts/Step Cache Fold.md`, "The gate".
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as Fold from "../src/Fold.ts"
import * as Migrations from "../src/Migrations.ts"

const journal = SqlJournal.layer({ capacity: 256, overflow: "reject" })

const layers = Layer.mergeAll(
  journal,
  CacheStoreLive.layer.pipe(Layer.provide(journal))
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

const withStores = <A, E>(
  body: Effect.Effect<A, E, CacheStore | Journal.Journal | DurableWriter | SqlClient.SqlClient>
) => body.pipe(Effect.provide(layers), Effect.scoped)

const entry = {
  keyDigest: "digest-1",
  result: { output: "ok" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 7
} as const

interface TableRow {
  readonly key_digest: string
  readonly result_json: string
  readonly meta_json: string
  readonly created_at_ms: number
  readonly recorded_run_id: string
  readonly recorded_event_seq: number
}

interface EventRow {
  readonly run_id: string
  readonly seq: number
  readonly source_id: string
  readonly source_seq: number
  readonly event_type: string
  readonly payload_json: string
  readonly meta_json: string
}

/** Both materializations, in a stable order, for byte-level comparison. */
const tables = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const head = yield* sql<TableRow>`
    SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
    FROM flows_step_cache ORDER BY key_digest
  `
  const ledger = yield* sql<TableRow>`
    SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
    FROM flows_step_cache_recorded ORDER BY key_digest, recorded_run_id, recorded_event_seq
  `
  return { head, ledger }
})

/** Every retained cache event, in the fold's replay order. */
const cacheEvents = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  return yield* sql<EventRow>`
    SELECT run_id, seq, source_id, source_seq, event_type, payload_json, meta_json
    FROM flows_journal_events
    WHERE event_type LIKE 'flows.cache.%'
    ORDER BY emitted_at_ms ASC, run_id ASC, seq ASC
  `
})

/**
 * The invariant under test: dropping the tables and replaying the journal
 * rebuilds byte-equal state.
 */
const rebuildMatchesLive = Effect.gen(function*() {
  const live = yield* tables
  const rebuilt = yield* Fold.rebuild
  const replayed = yield* tables
  expect(replayed).toEqual(live)
  return rebuilt
})

describe("Fold", () => {
  it.effect("appends the admitted entry verbatim and rebuilds it byte-for-byte", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      // A value the write-path redactor would otherwise rewrite: cached
      // results are executable state served verbatim on a hit (issue #72),
      // so `flows.cache.*` bypasses it.
      const secretive = { ...entry, result: { apiKey: "sk-live_secret12345", output: "ok" } }
      expect(yield* store.put(secretive)).toEqual({ _tag: "Inserted" })

      const events = yield* cacheEvents
      expect(events).toHaveLength(1)
      const event = events[0]!
      expect(event.run_id).toBe(entry.recordedRunId)
      expect(event.event_type).toBe("flows.cache.recorded")
      expect(event.source_seq).toBe(0)
      expect(event.payload_json).toContain("sk-live_secret12345")
      expect(JSON.parse(event.payload_json)).toEqual(secretive)
      expect(JSON.parse(event.meta_json)).toEqual({ lineageId: "run-1/root" })

      const rebuilt = yield* rebuildMatchesLive
      expect(rebuilt).toEqual({ entries: 1, head: 1, ledger: 1 })
      // The replay fence reads the very ledger row the rebuilt fold landed.
      const recorded = yield* store.get(entry.keyDigest, {
        recordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
      })
      expect(Option.getOrThrow(recorded)).toEqual(secretive)
    })))

  it.effect("an exact repeat changes nothing and appends nothing", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      // The convergence re-record after a crash between `attempts.finish`
      // and `cache.put`: same triple, same bytes — the fold's idempotency.
      expect(yield* store.put(entry)).toEqual({ _tag: "ExistingSame" })
      expect(yield* cacheEvents).toHaveLength(1)
      yield* rebuildMatchesLive
    })))

  it.effect("a duplicate under a new provenance appends its ledger-only event", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      yield* TestClock.adjust("1 millis")
      const agreeing = { ...entry, recordedRunId: "run-2", recordedEventSeq: 1 }
      expect(yield* store.put(agreeing)).toEqual({ _tag: "ExistingSame" })

      const events = yield* cacheEvents
      expect(events.map((event) => [event.run_id, event.event_type])).toEqual([
        ["run-1", "flows.cache.recorded"],
        ["run-2", "flows.cache.recorded"]
      ])
      const rebuilt = yield* rebuildMatchesLive
      // First writer keeps the head; the agreeing recording is a second
      // ledger generation a replay fence can still name.
      expect(rebuilt).toEqual({ entries: 2, head: 1, ledger: 2 })
      const state = yield* tables
      expect(state.head[0]!.recorded_run_id).toBe("run-1")
    })))

  it.effect("a conflict appends once, and its exact retry appends nothing", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      yield* TestClock.adjust("1 millis")
      // Strict versus `nondeterministic` is the engine's verdict above the
      // store; at this seam both are the same first-writer-wins admission,
      // and the loser's recording is journalled either way.
      const contender = { ...entry, result: { output: "different" }, recordedRunId: "run-3", recordedEventSeq: 2 }
      expect(yield* store.put(contender)).toEqual({ _tag: "Conflict" })
      expect(yield* cacheEvents).toHaveLength(2)
      // The retry's triple already holds its ledger row: no table changed,
      // so the refused write appends nothing.
      expect(yield* store.put(contender)).toEqual({ _tag: "Conflict" })
      expect(yield* cacheEvents).toHaveLength(2)

      const rebuilt = yield* rebuildMatchesLive
      expect(rebuilt).toEqual({ entries: 2, head: 1, ledger: 2 })
      const state = yield* tables
      expect(JSON.parse(state.head[0]!.result_json)).toEqual({ output: "ok" })
    })))

  it.effect("evictions journal the deleted generation, and refused evictions journal nothing", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      // A fence naming provenance the row does not carry deletes nothing and
      // appends nothing; neither does a key with no row at all.
      expect(
        yield* store.evict(entry.keyDigest, {
          ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq + 1 }
        })
      ).toBe(false)
      expect(yield* store.evict("digest-absent")).toBe(false)
      expect((yield* cacheEvents).map((event) => event.event_type)).toEqual(["flows.cache.recorded"])

      yield* TestClock.adjust("1 millis")
      expect(
        yield* store.evict(entry.keyDigest, {
          ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
        })
      ).toBe(true)
      const events = yield* cacheEvents
      expect(events.map((event) => event.event_type)).toEqual(["flows.cache.recorded", "flows.cache.evicted"])
      expect(JSON.parse(events[1]!.payload_json)).toEqual({
        keyDigest: entry.keyDigest,
        recordedRunId: entry.recordedRunId,
        recordedEventSeq: entry.recordedEventSeq
      })

      const rebuilt = yield* rebuildMatchesLive
      // The eviction event is what keeps a rebuild from resurrecting the
      // deleted head; the ledger generation survives for the replay fence.
      expect(rebuilt).toEqual({ entries: 2, head: 0, ledger: 1 })
      expect(Option.isNone(yield* store.get(entry.keyDigest))).toBe(true)
    })))

  it.effect("an unconditional evict appends under the deleted row's recorded run", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put({ ...entry, recordedRunId: "run-9", recordedEventSeq: 3 })
      yield* TestClock.adjust("1 millis")
      expect(yield* store.evict(entry.keyDigest)).toBe(true)
      const events = yield* cacheEvents
      expect(events[1]!.event_type).toBe("flows.cache.evicted")
      expect(events[1]!.run_id).toBe("run-9")
      expect(JSON.parse(events[1]!.meta_json)).toEqual({ lineageId: "run-9/root" })
      yield* rebuildMatchesLive
    })))

  it.effect("an identical re-record after an eviction journals at the identity's next sourceSeq", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      // The quarantine-evict-then-identical-re-record path (issues #129 and
      // #164): the re-record shares the evicted generation's provenance by
      // design, so without the `sourceSeq` advance its append would collapse
      // into a `Duplicate` of the original and a rebuild would end at the
      // eviction — head empty where the live table has a row.
      yield* store.put(entry)
      yield* TestClock.adjust("1 millis")
      yield* store.evict(entry.keyDigest, {
        ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
      })
      yield* TestClock.adjust("1 millis")
      expect(yield* store.put(entry)).toEqual({ _tag: "Inserted" })

      const events = yield* cacheEvents
      expect(new Set(events.map((event) => event.source_id)).size).toBe(1)
      expect(events.map((event) => [event.event_type, event.source_seq])).toEqual([
        ["flows.cache.recorded", 0],
        ["flows.cache.evicted", 1],
        ["flows.cache.recorded", 2]
      ])
      const rebuilt = yield* rebuildMatchesLive
      expect(rebuilt).toEqual({ entries: 3, head: 1, ledger: 1 })
      expect(Option.isSome(yield* store.get(entry.keyDigest))).toBe(true)
    })))

  it.effect("a foreign-recorded write-back appends under the recording run", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      // A shared-tier hit written back locally carries the foreign run's
      // provenance and has no local owner to fence by: the event appends
      // unfenced under the run that recorded it.
      yield* store.put({ ...entry, recordedRunId: "foreign-run", recordedEventSeq: 12 })
      const events = yield* cacheEvents
      expect(events[0]!.run_id).toBe("foreign-run")
      expect(JSON.parse(events[0]!.meta_json)).toEqual({ lineageId: "foreign-run/root" })
      yield* rebuildMatchesLive
      const recorded = yield* store.get(entry.keyDigest, {
        recordedBy: { runId: "foreign-run", eventSeq: 12 }
      })
      expect(Option.isSome(recorded)).toBe(true)
    })))

  it.effect("the projections fold one run's stream to the tables' state", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      const journalService = yield* Journal.Journal
      yield* store.put(entry)
      yield* store.evict(entry.keyDigest)
      yield* store.put(entry)
      yield* store.put({ ...entry, keyDigest: "digest-2", recordedEventSeq: 8 })
      // A foreign namespace in the same run: a projection selects its own
      // events and must leave state untouched for everything else.
      yield* journalService.emitDurable(
        new JournalEvent.Input({
          runId: entry.recordedRunId as JournalEvent.RunId,
          sourceId: "foreign" as JournalEvent.SourceId,
          eventType: "flows.engine.run-decision",
          payload: { decision: "ignored" },
          meta: { lineageId: "run-1/root" }
        })
      )
      // A cache-namespaced type this fold does not know yet: adding an event
      // type to the namespace must not be a breaking change for the reducers.
      yield* journalService.emitDurable(
        new JournalEvent.Input({
          runId: entry.recordedRunId as JournalEvent.RunId,
          sourceId: "future" as JournalEvent.SourceId,
          eventType: "flows.cache.reserved-future",
          payload: {},
          meta: { lineageId: "run-1/root" }
        })
      )

      const page = yield* journalService.entries({
        runId: entry.recordedRunId as JournalEvent.RunId,
        limit: 100
      })
      let head = Fold.head.initial
      let ledger = Fold.ledger.initial
      for (const event of page.entries) {
        const skipped = !event.eventType.startsWith(Fold.namespace)
        const nextHead = yield* Fold.head.reduce(head, event)
        const nextLedger = yield* Fold.ledger.reduce(ledger, event)
        if (skipped) {
          expect(nextHead).toBe(head)
          expect(nextLedger).toBe(ledger)
        }
        head = nextHead
        ledger = nextLedger
      }

      expect([...head.keys()].sort()).toEqual(["digest-1", "digest-2"])
      expect(head.get("digest-1")).toEqual(entry)
      expect([...ledger.keys()].sort()).toEqual([
        Fold.tripleKey("digest-1", "run-1", 7),
        Fold.tripleKey("digest-2", "run-1", 8)
      ].sort())
      expect(Fold.head.name).toBe("@smthrs/step-cache/Fold/head")
      expect(Fold.ledger.name).toBe("@smthrs/step-cache/Fold/ledger")
    })))

  it.effect("snapshots assert rows, and later events apply on top of them", () =>
    withStores(Effect.gen(function*() {
      const store = yield* CacheStore
      const journalService = yield* Journal.Journal
      const snapshot = (table: "head" | "recorded", snapshotted: CacheStoreLive.CacheEntry) =>
        journalService.emitDurable(
          new JournalEvent.Input({
            runId: snapshotted.recordedRunId as JournalEvent.RunId,
            sourceId: `snapshot:${table}:${snapshotted.keyDigest}` as JournalEvent.SourceId,
            eventType: "flows.cache.snapshot",
            payload: { table, ...snapshotted },
            meta: { lineageId: `${snapshotted.recordedRunId}/root` }
          })
        )
      // A pre-fold row asserted by the migration's snapshots.
      yield* snapshot("head", entry)
      yield* snapshot("recorded", entry)
      const rebuilt = yield* Fold.rebuild
      expect(rebuilt).toEqual({ entries: 2, head: 1, ledger: 1 })
      expect(Option.getOrThrow(yield* store.get(entry.keyDigest))).toEqual(entry)

      // A later eviction still deletes the snapshot-asserted head.
      yield* TestClock.adjust("1 millis")
      yield* store.evict(entry.keyDigest)
      const evicted = yield* rebuildMatchesLive
      expect(evicted).toEqual({ entries: 3, head: 0, ledger: 1 })

      // Snapshots never displace what an earlier event already decided:
      // an occupied key and an existing generation are both kept.
      yield* store.put({ ...entry, keyDigest: "digest-2" })
      yield* TestClock.adjust("1 millis")
      yield* snapshot("head", {
        ...entry,
        keyDigest: "digest-2",
        recordedRunId: "run-later",
        result: { output: "later" }
      })
      yield* snapshot("recorded", { ...entry, keyDigest: "digest-2", result: { output: "later" } })
      yield* rebuildMatchesLive
      const state = yield* tables
      expect(state.head.map((row) => [row.key_digest, row.recorded_run_id])).toEqual([["digest-2", "run-1"]])
    })))

  it.effect("rebuild tolerates a foreign eviction and reports corrupt payloads as decode_failed", () =>
    withStores(Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const journalService = yield* Journal.Journal
      // An eviction whose generation no retained event recorded: the fold
      // leaves the vacant head vacant rather than failing.
      yield* journalService.emitDurable(
        new JournalEvent.Input({
          runId: "run-x" as JournalEvent.RunId,
          sourceId: "foreign-evict" as JournalEvent.SourceId,
          eventType: "flows.cache.evicted",
          payload: { keyDigest: "digest-x", recordedRunId: "run-x", recordedEventSeq: 0 },
          meta: { lineageId: "run-x/root" }
        })
      )
      expect(yield* Fold.rebuild).toEqual({ entries: 1, head: 0, ledger: 0 })

      // Structurally invalid payloads under each cache event type fail the
      // rebuild as typed decode errors, never as defects.
      const corrupt = (eventType: string) =>
        Effect.gen(function*() {
          yield* journalService.emitDurable(
            new JournalEvent.Input({
              runId: "run-corrupt" as JournalEvent.RunId,
              sourceId: `corrupt:${eventType}` as JournalEvent.SourceId,
              eventType,
              payload: "nonsense",
              meta: { lineageId: "run-corrupt/root" }
            })
          )
          const failure = yield* Effect.flip(Fold.rebuild)
          expect(failure.code).toBe("decode_failed")
          yield* sql`DELETE FROM flows_journal_events WHERE run_id = ${"run-corrupt"}`
        })
      yield* corrupt("flows.cache.recorded")
      yield* corrupt("flows.cache.evicted")
      yield* corrupt("flows.cache.snapshot")

      // A payload column that is not JSON at all — the row arrives from
      // outside this schema's enforcement — is the same typed failure.
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`
        INSERT INTO flows_journal_events (
          run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
        ) VALUES ('run-raw', 0, 'raw-0', 'raw', 0, 0, 'flows.cache.recorded', 'not-json', 'null')
      `
      yield* sql`PRAGMA ignore_check_constraints = OFF`
      const failure = yield* Effect.flip(Fold.rebuild)
      expect(failure.code).toBe("decode_failed")
    })))

  it.effect("rebuild surfaces a storage failure as persistence_failed", () =>
    withStores(Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE flows_step_cache`
      const failure = yield* Effect.flip(Fold.rebuild)
      expect(failure.code).toBe("persistence_failed")
    })))
})
