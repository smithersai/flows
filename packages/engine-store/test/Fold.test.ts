/**
 * Rebuild/conformance suite for the deferred/clock journal fold
 * (`docs/specs/Concepts/Deferred Clock Fold.md`): at every commit,
 * `flows_deferred_completions` and `flows_clock_deadlines` equal the fold of
 * the journal. Each case drives the write paths through
 * `internal/DeferredPersistence`, then compares the live index reads with a
 * replayed fold of the committed entries. The suite runs against the SQL and
 * in-memory `DurableEngineState` implementations, the
 * `DurableEngineStateContract` pattern; the rebuild, restart-recovery, and
 * migration-backfill cases are SQL-only because `Fold.rebuild` writes the
 * tables themselves.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableClock, Flow } from "@smthrs/flow"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import type { Ownership } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Fold from "../src/Fold.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as Migrations from "../src/Migrations.ts"
import deferredClockFold from "../src/migrations/0003_deferred_clock_fold.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "fold-test", pid: 1, nonce: "owner" }
const stranger: Ownership.OwnerId = { hostId: "fold-test", pid: 2, nonce: "stranger" }
const journalSource = "fold-test"

const TestFlow = Flow.make("Fold/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const sqlStack = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

const journalStack = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provideMerge(migratedDatabase)
)

/**
 * The byte-exactness contract lives on the JSON encoding, so both sides of a
 * comparison are normalized through one JSON round-trip: a live in-memory row
 * may hold an `Exit` class instance where the fold holds its decoded
 * structural twin.
 */
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** Replays the committed journal of one run through both fold reducers. */
const foldRun = (journal: Journal.Service, runId: string) =>
  Effect.gen(function*() {
    let deferreds = Fold.deferredProjection.initial
    let clocks = Fold.clockProjection.initial
    let after: JournalEvent.Seq | undefined = undefined
    for (;;) {
      const page: Journal.EntriesPage = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 64
      })
      for (const entry of page.entries) {
        deferreds = yield* Fold.deferredProjection.reduce(deferreds, entry)
        clocks = yield* Fold.clockProjection.reduce(clocks, entry)
      }
      const last = page.entries.at(-1)
      if (!page.hasMore || last === undefined) break
      after = last.seq
    }
    return { deferreds, clocks }
  })

const eventsOf = (journal: Journal.Service, runId: string, eventType: string) =>
  Effect.map(
    journal.entries({ runId: runId as JournalEvent.RunId, limit: 500 }),
    (page) => page.entries.filter((entry) => entry.eventType === eventType)
  )

/** Appends one hand-built record, the way another version or source wrote it. */
const rawEvent = (
  journal: Journal.Service,
  runId: string,
  sourceId: string,
  eventType: string,
  payload: unknown
) =>
  journal.emitDurable(
    new JournalEvent.Input({
      runId: runId as JournalEvent.RunId,
      sourceId: sourceId as JournalEvent.SourceId,
      sourceSeq: 0 as JournalEvent.SourceSeq,
      eventType,
      payload,
      meta: { lineageId: `${runId}/root` }
    }, { disableChecks: true })
  )

/** Observes a fence loss (self-interruption) as an Exit on a child fiber. */
const awaitExit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Exit.Exit<A, E>, never, R> =>
  effect.pipe(Effect.forkChild({ startImmediately: true }), Effect.flatMap(Fiber.await))

interface FoldContext {
  readonly state: DurableEngineState.Service
  readonly journal: Journal.Service
  readonly resumes: Array<string>
  /** Builds a persistence service over the same storage (a fresh process). */
  readonly persistence: (
    asOwner?: Ownership.OwnerId
  ) => Effect.Effect<DeferredPersistence.Service, never, Scope.Scope>
  readonly seedRun: (runId: string) => Effect.Effect<void>
  readonly folded: (runId: string) => Effect.Effect<{
    readonly deferreds: Fold.DeferredFoldState
    readonly clocks: Fold.ClockFoldState
  }, Journal.JournalError>
  readonly events: (
    runId: string,
    eventType: string
  ) => Effect.Effect<ReadonlyArray<JournalEvent.Entry>, Journal.JournalError>
}

interface FoldHarness {
  readonly label: string
  readonly run: <A>(
    body: (context: FoldContext) => Effect.Effect<
      A,
      any,
      Scope.Scope | SqlClient.SqlClient | DurableWriter.DurableWriter | Journal.Journal
    >
  ) => Effect.Effect<A>
}

const makeContext = (
  state: DurableEngineState.Service,
  journal: Journal.Service,
  seedRun: (runId: string) => Effect.Effect<void>
): FoldContext => {
  const resumes: Array<string> = []
  return {
    state,
    journal,
    resumes,
    persistence: (asOwner = owner) =>
      DeferredPersistence.make({
        owner: asOwner,
        journalSource,
        scheduleResume: (_flowName, executionId, reason) =>
          Effect.sync(() => {
            resumes.push(`${executionId}:${reason}`)
          })
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Journal.Journal, journal)
      ),
    seedRun,
    folded: (runId) => foldRun(journal, runId),
    events: (runId, eventType) => eventsOf(journal, runId, eventType)
  }
}

const sqlHarness: FoldHarness = {
  label: "sql",
  run: (body) =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const journal = yield* Journal.Journal
        const state = yield* DurableEngineState.DurableEngineState
        const context = makeContext(state, journal, (runId) =>
          sql`
            INSERT INTO flows_runs (
              run_id, status, created_at_ms,
              owner_host_id, owner_pid, owner_nonce,
              heartbeat_at_ms, state_json
            ) VALUES (
              ${runId}, 'running', 0,
              ${owner.hostId}, ${owner.pid}, ${owner.nonce},
              0, '{}'
            )
          `.pipe(Effect.orDie, Effect.asVoid))
        return yield* body(context)
      })).pipe(Effect.provide(sqlStack), Effect.provide(TestClock.layer())) as Effect.Effect<never>
    )
}

const memoryHarness: FoldHarness = {
  label: "memory",
  run: (body) => {
    const runs = new Map<string, DurableEngineState.MemoryRunView>()
    const state = DurableEngineState.makeMemory({
      runs: (runId) => Option.fromNullishOr(runs.get(runId))
    })
    return withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const context = makeContext(state, journal, (runId) =>
          Effect.sync(() => {
            runs.set(runId, { status: "running", owner })
          }))
        return yield* body(context)
      })).pipe(Effect.provide(journalStack), Effect.provide(TestClock.layer())) as Effect.Effect<never>
    )
  }
}

const describeConformance = (harness: FoldHarness): void => {
  describe(`the deferred/clock fold equals the live index (${harness.label})`, () => {
    it.effect("a first completion folds to the row the index serves, self-contained", () =>
      Effect.gen(function*() {
        const address = {
          flowName: TestFlow._tag,
          executionId: "fold-first",
          deferredName: "answer"
        }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(address.executionId)
            const service = yield* context.persistence()
            yield* service.deferredDone({
              ...address,
              exit: Exit.succeed("first"),
              metadata: { correlationId: "opaque" }
            })
            return {
              live: Option.getOrThrow(yield* context.state.deferred(address)),
              fold: yield* context.folded(address.executionId),
              events: yield* context.events(address.executionId, Fold.eventTypes.deferredCompleted),
              resumes: [...context.resumes]
            }
          })
        )

        expect(result.events).toHaveLength(1)
        // The record is self-contained: the one column it never carried.
        expect((result.events[0]!.payload as { completedAtMs: number }).completedAtMs).toBe(
          result.live.completedAtMs
        )
        expect([...result.fold.deferreds.values()].map(normalize)).toEqual([normalize(result.live)])
        expect(result.fold.clocks.size).toBe(0)
        expect(result.resumes).toEqual([`${address.executionId}:deferred`])
      }))

    it.effect("a duplicate completion keeps the first row and appends nothing", () =>
      Effect.gen(function*() {
        const address = {
          flowName: TestFlow._tag,
          executionId: "fold-duplicate",
          deferredName: "answer"
        }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(address.executionId)
            const service = yield* context.persistence()
            yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
            yield* service.deferredDone({ ...address, exit: Exit.succeed("different") })
            return {
              live: Option.getOrThrow(yield* context.state.deferred(address)),
              fold: yield* context.folded(address.executionId),
              events: yield* context.events(address.executionId, Fold.eventTypes.deferredCompleted)
            }
          })
        )

        expect(result.events).toHaveLength(1)
        expect(normalize(result.live.exit)).toEqual(normalize(Exit.succeed("first")))
        expect([...result.fold.deferreds.values()].map(normalize)).toEqual([normalize(result.live)])
      }))

    it.effect("a scheduled deadline folds to the pending row the sweeper reads", () =>
      Effect.gen(function*() {
        const executionId = "fold-scheduled"
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            const service = yield* context.persistence()
            yield* service.scheduleClock(TestFlow, {
              executionId,
              clock: DurableClock.make({ name: "wake", duration: "10 seconds" })
            })
            return {
              live: yield* context.state.pendingClocks({ executionId }),
              fold: yield* context.folded(executionId),
              events: yield* context.events(executionId, Fold.eventTypes.clockScheduled)
            }
          })
        )

        expect(result.live).toHaveLength(1)
        expect(result.live[0]!.completedAtMs).toBeNull()
        expect(result.events).toHaveLength(1)
        expect([...result.fold.clocks.values()].map(normalize)).toEqual(result.live.map(normalize))
        expect(result.fold.deferreds.size).toBe(0)
      }))

    it.effect("a fenced schedule refusal leaves no row and no record", () =>
      Effect.gen(function*() {
        const executionId = "fold-fenced"
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            const service = yield* context.persistence(stranger)
            const refused = yield* awaitExit(service.scheduleClock(TestFlow, {
              executionId,
              clock: DurableClock.make({ name: "wake", duration: "10 seconds" })
            }))
            return {
              refused,
              live: yield* context.state.pendingClocks({ executionId }),
              fold: yield* context.folded(executionId),
              events: yield* context.events(executionId, Fold.eventTypes.clockScheduled)
            }
          })
        )

        expect(Exit.isFailure(result.refused) && Cause.hasInterruptsOnly(result.refused.cause)).toBe(true)
        expect(result.live).toHaveLength(0)
        expect(result.events).toHaveLength(0)
        expect(result.fold.clocks.size).toBe(0)
      }))

    it.effect("a fired deadline folds to the completed clock and the deferred it resolved", () =>
      Effect.gen(function*() {
        const executionId = "fold-fired"
        const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            const service = yield* context.persistence()
            yield* service.scheduleClock(TestFlow, { executionId, clock })
            yield* TestClock.adjust("10 seconds")
            yield* Effect.yieldNow
            return {
              liveClock: Option.getOrThrow(
                yield* context.state.clock({
                  flowName: TestFlow._tag,
                  executionId,
                  clockName: clock.name
                })
              ),
              liveDeferred: Option.getOrThrow(
                yield* context.state.deferred({
                  flowName: TestFlow._tag,
                  executionId,
                  deferredName: clock.deferred.name
                })
              ),
              fold: yield* context.folded(executionId),
              completions: yield* context.events(executionId, Fold.eventTypes.clockCompleted),
              deferredEvents: yield* context.events(executionId, Fold.eventTypes.deferredCompleted),
              resumes: [...context.resumes]
            }
          })
        )

        expect(result.liveClock.completedAtMs).toBe(10_000)
        expect(result.completions).toHaveLength(1)
        expect(result.completions[0]!.payload).toEqual({
          flowName: TestFlow._tag,
          executionId,
          clockName: clock.name,
          completedAtMs: 10_000
        })
        expect(result.deferredEvents).toHaveLength(1)
        expect([...result.fold.clocks.values()].map(normalize)).toEqual([normalize(result.liveClock)])
        expect([...result.fold.deferreds.values()].map(normalize)).toEqual([normalize(result.liveDeferred)])
        expect(result.resumes).toEqual([`${executionId}:clock`])
      }))

    it.effect("a deadline completed early never fires and never resurrects on replay", () =>
      Effect.gen(function*() {
        const executionId = "fold-cancelled"
        const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })
        const address = { flowName: TestFlow._tag, executionId, clockName: clock.name }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            // The scheduling process goes away with its scope; its armed
            // timer dies with it, the way a restart kills one.
            yield* Effect.scoped(Effect.gen(function*() {
              const service = yield* context.persistence()
              yield* service.scheduleClock(TestFlow, { executionId, clock })
            }))
            const cancelled = yield* DeferredPersistence.completeClockDurable({
              journalSource,
              address,
              completedAtMs: 5_000
            }).pipe(
              Effect.provideService(DurableEngineState.DurableEngineState, context.state),
              Effect.provideService(Journal.Journal, context.journal)
            )
            // A fresh process sweeps: a completed deadline is not pending, so
            // nothing re-arms, and past the original deadline nothing fires.
            const restarted = yield* context.persistence()
            yield* restarted.sweepDue(TestFlow._tag)
            yield* TestClock.adjust("20 seconds")
            yield* Effect.yieldNow
            return {
              cancelled,
              liveClock: Option.getOrThrow(yield* context.state.clock(address)),
              liveDeferred: yield* context.state.deferred({
                flowName: TestFlow._tag,
                executionId,
                deferredName: clock.deferred.name
              }),
              fold: yield* context.folded(executionId),
              completions: yield* context.events(executionId, Fold.eventTypes.clockCompleted),
              resumes: [...context.resumes]
            }
          })
        )

        expect(result.cancelled._tag).toBe("Completed")
        expect(result.liveClock.completedAtMs).toBe(5_000)
        expect(Option.isNone(result.liveDeferred)).toBe(true)
        expect(result.completions).toHaveLength(1)
        expect(result.resumes).toEqual([])
        expect([...result.fold.clocks.values()].map(normalize)).toEqual([normalize(result.liveClock)])
        expect(result.fold.deferreds.size).toBe(0)
      }))

    it.effect("an armed fire validates against the completed row and is skipped (temporal's fire-time validation)", () =>
      Effect.gen(function*() {
        const executionId = "fold-skipped-fire"
        const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })
        const address = { flowName: TestFlow._tag, executionId, clockName: clock.name }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            const service = yield* context.persistence()
            yield* service.scheduleClock(TestFlow, { executionId, clock })
            // Completed early while the timer is still armed in-process.
            yield* DeferredPersistence.completeClockDurable({
              journalSource,
              address,
              completedAtMs: 1_000
            }).pipe(
              Effect.provideService(DurableEngineState.DurableEngineState, context.state),
              Effect.provideService(Journal.Journal, context.journal)
            )
            yield* TestClock.adjust("10 seconds")
            yield* Effect.yieldNow
            return {
              liveClock: Option.getOrThrow(yield* context.state.clock(address)),
              liveDeferred: yield* context.state.deferred({
                flowName: TestFlow._tag,
                executionId,
                deferredName: clock.deferred.name
              }),
              fold: yield* context.folded(executionId),
              completions: yield* context.events(executionId, Fold.eventTypes.clockCompleted),
              deferredEvents: yield* context.events(executionId, Fold.eventTypes.deferredCompleted),
              resumes: [...context.resumes]
            }
          })
        )

        // The timer's task was skipped: the deadline stayed completed at its
        // early instant, the deferred never resolved, nothing resumed.
        expect(result.liveClock.completedAtMs).toBe(1_000)
        expect(Option.isNone(result.liveDeferred)).toBe(true)
        expect(result.completions).toHaveLength(1)
        expect(result.deferredEvents).toHaveLength(0)
        expect(result.resumes).toEqual([])
        expect([...result.fold.clocks.values()].map(normalize)).toEqual([normalize(result.liveClock)])
      }))

    it.effect("a duplicate completion CAS reports AlreadyCompleted and appends nothing", () =>
      Effect.gen(function*() {
        const executionId = "fold-cas-duplicate"
        const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })
        const address = { flowName: TestFlow._tag, executionId, clockName: clock.name }
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            yield* Effect.scoped(Effect.gen(function*() {
              const service = yield* context.persistence()
              yield* service.scheduleClock(TestFlow, { executionId, clock })
            }))
            const completeAt = (completedAtMs: number) =>
              DeferredPersistence.completeClockDurable({ journalSource, address, completedAtMs }).pipe(
                Effect.provideService(DurableEngineState.DurableEngineState, context.state),
                Effect.provideService(Journal.Journal, context.journal)
              )
            const first = yield* completeAt(5_000)
            const second = yield* completeAt(6_000)
            const missing = yield* DeferredPersistence.completeClockDurable({
              journalSource,
              address: { ...address, clockName: "ghost" },
              completedAtMs: 7_000
            }).pipe(
              Effect.provideService(DurableEngineState.DurableEngineState, context.state),
              Effect.provideService(Journal.Journal, context.journal)
            )
            return {
              first,
              second,
              missing,
              liveClock: Option.getOrThrow(yield* context.state.clock(address)),
              fold: yield* context.folded(executionId),
              completions: yield* context.events(executionId, Fold.eventTypes.clockCompleted)
            }
          })
        )

        expect(result.first._tag).toBe("Completed")
        expect(result.second._tag).toBe("AlreadyCompleted")
        expect(result.missing).toEqual({ _tag: "NotFound" })
        expect(result.liveClock.completedAtMs).toBe(5_000)
        expect(result.completions).toHaveLength(1)
        expect([...result.fold.clocks.values()].map(normalize)).toEqual([normalize(result.liveClock)])
      }))

    it.effect("an administrative snapshot seeds an unseen address and never overrides committed history", () =>
      Effect.gen(function*() {
        const executionId = "fold-snapshot"
        const options = (sourceId: string) => ({
          runId: executionId,
          lineageId: `${executionId}/root`,
          sourceId,
          sourceSeq: 0
        })
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            const service = yield* context.persistence()
            yield* service.deferredDone({
              flowName: TestFlow._tag,
              executionId,
              deferredName: "answer",
              exit: Exit.succeed("first")
            })
            // A checkpointing snapshot re-states the completed row; the fold
            // already saw its record, so the snapshot folds to nothing even
            // when its copy disagrees.
            yield* context.journal.emitDurable(JournalRecords.deferredSnapshot(
              options("checkpoint:deferred:answer"),
              {
                flowName: TestFlow._tag,
                executionId,
                deferredName: "answer",
                exit: { _tag: "Success", value: "stale-checkpoint-copy" },
                completedAtMs: 999
              }
            ))
            // Snapshots of rows this journal never recorded — a disaster
            // rebuild's imports — seed their addresses exactly.
            yield* context.journal.emitDurable(JournalRecords.deferredSnapshot(
              options("import:deferred:imported"),
              {
                flowName: TestFlow._tag,
                executionId,
                deferredName: "imported",
                exit: { _tag: "Success", value: "imported" },
                metadata: { via: "import" },
                completedAtMs: 3
              }
            ))
            yield* context.journal.emitDurable(JournalRecords.clockSnapshot(
              options("import:clock:pending"),
              {
                flowName: TestFlow._tag,
                executionId,
                clockName: "pending",
                deferredName: "DurableClock/pending",
                dueAtMs: 90,
                completedAtMs: null
              }
            ))
            // A second snapshot of a row the fold already completed changes
            // nothing: first completion per address wins.
            yield* context.journal.emitDurable(JournalRecords.clockSnapshot(
              options("import:clock:finished"),
              {
                flowName: TestFlow._tag,
                executionId,
                clockName: "finished",
                deferredName: "DurableClock/finished",
                dueAtMs: 10,
                completedAtMs: 20
              }
            ))
            yield* context.journal.emitDurable(JournalRecords.clockSnapshot(
              options("recheckpoint:clock:finished"),
              {
                flowName: TestFlow._tag,
                executionId,
                clockName: "finished",
                deferredName: "DurableClock/finished",
                dueAtMs: 10,
                completedAtMs: 25
              }
            ))
            return {
              live: Option.getOrThrow(
                yield* context.state.deferred({
                  flowName: TestFlow._tag,
                  executionId,
                  deferredName: "answer"
                })
              ),
              fold: yield* context.folded(executionId)
            }
          })
        )

        const answer = result.fold.deferreds.get(Fold.deferredKey({
          flowName: TestFlow._tag,
          executionId,
          deferredName: "answer"
        }))
        expect(normalize(answer)).toEqual(normalize(result.live))
        const imported = result.fold.deferreds.get(Fold.deferredKey({
          flowName: TestFlow._tag,
          executionId,
          deferredName: "imported"
        }))
        expect(imported).toEqual({
          flowName: TestFlow._tag,
          executionId,
          deferredName: "imported",
          exit: { _tag: "Success", value: "imported" },
          metadata: { via: "import" },
          completedAtMs: 3
        })
        const clocks = [...result.fold.clocks.values()]
        expect(clocks).toHaveLength(2)
        expect(clocks.find((row) => row.clockName === "pending")?.completedAtMs).toBeNull()
        expect(clocks.find((row) => row.clockName === "finished")?.completedAtMs).toBe(20)
      }))

    it.effect("records the reducers cannot read fold to nothing, and the first writer wins across sources", () =>
      Effect.gen(function*() {
        const executionId = "fold-selects"
        const result = yield* harness.run((context) =>
          Effect.gen(function*() {
            yield* context.seedRun(executionId)
            // Records another version wrote that these reducers cannot read:
            // each is skipped, never folded wrong.
            yield* rawEvent(context.journal, executionId, "broken:deferred", Fold.eventTypes.deferredSnapshot, {
              flowName: TestFlow._tag,
              executionId,
              deferredName: "broken"
            })
            yield* rawEvent(context.journal, executionId, "broken:scheduled", Fold.eventTypes.clockScheduled, {})
            yield* rawEvent(context.journal, executionId, "broken:completed", Fold.eventTypes.clockCompleted, {
              flowName: TestFlow._tag,
              executionId,
              clockName: "wake"
            })
            yield* rawEvent(context.journal, executionId, "broken:snapshot", Fold.eventTypes.clockSnapshot, {
              flowName: TestFlow._tag,
              executionId,
              clockName: "wake"
            })
            // A completion for an address the fold never saw has no row to
            // complete.
            yield* rawEvent(context.journal, executionId, "orphan:completed", Fold.eventTypes.clockCompleted, {
              flowName: TestFlow._tag,
              executionId,
              clockName: "orphan",
              completedAtMs: 7
            })
            // Two sources announce one deadline and two sources complete it:
            // the first record wins on both axes.
            const schedule = (sourceId: string, dueAtMs: number) =>
              rawEvent(context.journal, executionId, sourceId, Fold.eventTypes.clockScheduled, {
                flowName: TestFlow._tag,
                executionId,
                clockName: "wake",
                deferredName: "DurableClock/wake",
                dueAtMs
              })
            const complete = (sourceId: string, completedAtMs: number) =>
              rawEvent(context.journal, executionId, sourceId, Fold.eventTypes.clockCompleted, {
                flowName: TestFlow._tag,
                executionId,
                clockName: "wake",
                completedAtMs
              })
            yield* schedule("host-a:clock:wake", 100)
            yield* schedule("host-b:clock:wake", 999)
            yield* complete("host-a:clock:wake:done", 150)
            yield* complete("host-b:clock:wake:done", 151)
            return { fold: yield* context.folded(executionId) }
          })
        )

        expect(result.fold.deferreds.size).toBe(0)
        expect([...result.fold.clocks.values()]).toEqual([{
          flowName: TestFlow._tag,
          executionId,
          clockName: "wake",
          deferredName: "DurableClock/wake",
          dueAtMs: 100,
          completedAtMs: 150
        }])
      }))
  })
}

describeConformance(sqlHarness)
describeConformance(memoryHarness)

const dumpTables = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const deferreds = yield* sql`
    SELECT flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms
    FROM flows_deferred_completions
    ORDER BY flow_name, execution_id, deferred_name
  `
  const clocks = yield* sql`
    SELECT flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms
    FROM flows_clock_deadlines
    ORDER BY flow_name, execution_id, clock_name
  `
  return { deferreds, clocks }
})

describe("Fold.rebuild (sql)", () => {
  it.effect("recomputes both tables from the journal byte-for-byte, and recovery resumes from the rebuilt index", () =>
    Effect.gen(function*() {
      const executionId = "rebuild-run"
      const pending = DurableClock.make({ name: "pending", duration: "100 seconds" })
      const fired = DurableClock.make({ name: "fired", duration: "10 seconds" })
      const cancelled = DurableClock.make({ name: "cancelled", duration: "50 seconds" })
      const result = yield* sqlHarness.run((context) =>
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const writer = yield* DurableWriter.DurableWriter
          yield* context.seedRun(executionId)
          // One of every fate: an external completion, a pending deadline, a
          // fired deadline, and an early-completed one — armed by a process
          // whose scope then closes, the way a restart kills its timers.
          yield* Effect.scoped(Effect.gen(function*() {
            const service = yield* context.persistence()
            yield* service.deferredDone({
              flowName: TestFlow._tag,
              executionId,
              deferredName: "answer",
              exit: Exit.succeed("external"),
              metadata: { correlationId: "opaque" }
            })
            yield* service.scheduleClock(TestFlow, { executionId, clock: pending })
            yield* service.scheduleClock(TestFlow, { executionId, clock: fired })
            yield* service.scheduleClock(TestFlow, { executionId, clock: cancelled })
            yield* TestClock.adjust("10 seconds")
            yield* Effect.yieldNow
          }))
          yield* DeferredPersistence.completeClockDurable({
            journalSource,
            address: { flowName: TestFlow._tag, executionId, clockName: cancelled.name },
            completedAtMs: 12_000
          }).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, context.state),
            Effect.provideService(Journal.Journal, context.journal)
          )
          // Pad the run's history past one rebuild page, so the replay pages
          // through it the way a long-lived run's rebuild would.
          yield* Effect.forEach(
            Array.from({ length: 70 }, (_, index) => index),
            (index) =>
              rawEvent(
                context.journal,
                executionId,
                `filler:${index}`,
                "flows.engine.run-decision",
                { decision: "filler", index }
              ),
            { discard: true }
          )
          const before = yield* dumpTables

          // Corrupt the wakeup indexes: resurrect the fired clock and drop
          // every completion row. The journal is the contract; the tables
          // must be recomputable from it alone.
          yield* writer.write(Effect.gen(function*() {
            yield* sql`UPDATE flows_clock_deadlines SET completed_at_ms = NULL WHERE clock_name = ${fired.name}`
            yield* sql`DELETE FROM flows_deferred_completions`
          }))
          const rebuilt = yield* Fold.rebuild
          const after = yield* dumpTables

          // Restart recovery: the registration sweep reads the rebuilt index —
          // it re-arms the pending deadline and re-drives the completions.
          context.resumes.length = 0
          const restarted = yield* context.persistence()
          yield* restarted.sweepDue(TestFlow._tag)
          const resumesAfterSweep = [...context.resumes]
          yield* TestClock.adjust("90 seconds")
          yield* Effect.yieldNow
          return {
            before,
            rebuilt,
            after,
            resumesAfterSweep,
            resumes: [...context.resumes],
            pendingAfterFire: yield* context.state.pendingClocks({ executionId }),
            cancelledDeferred: yield* context.state.deferred({
              flowName: TestFlow._tag,
              executionId,
              deferredName: cancelled.deferred.name
            })
          }
        })
      )

      expect(result.rebuilt).toEqual({ deferreds: 2, clocks: 3 })
      expect(result.after).toEqual(result.before)
      // The sweep re-drove both completed deferreds through the claim path.
      expect(result.resumesAfterSweep).toEqual(expect.arrayContaining([
        `${executionId}:deferred`
      ]))
      // The pending deadline re-armed and fired at its original instant; the
      // cancelled one never fired and its deferred never resolved.
      expect(result.resumes).toContain(`${executionId}:clock`)
      expect(result.pendingAfterFire).toHaveLength(0)
      expect(Option.isNone(result.cancelledDeferred)).toBe(true)
    }))

  it.effect("a pre-fold database survives migrate, drop, and rebuild with equivalent state", () =>
    Effect.gen(function*() {
      const executionId = "legacy-run"
      const emptyRun = "legacy-empty"
      const result = yield* sqlHarness.run((context) =>
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const writer = yield* DurableWriter.DurableWriter
          yield* context.seedRun(executionId)
          yield* context.seedRun(emptyRun)

          // A pre-fold history, written the way the old contract wrote it:
          // rows in the tables; a deferred-completed record WITHOUT
          // `completedAtMs`; a schedule record but no completion record for
          // a fired clock; a row with no record at all; and a run whose
          // journal has no entries whatsoever.
          yield* writer.write(Effect.gen(function*() {
            yield* sql`
              INSERT INTO flows_deferred_completions (
                flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms
              ) VALUES
                (${TestFlow._tag}, ${executionId}, 'answer', '{"_tag":"Success","value":"legacy"}', NULL, 5),
                (${TestFlow._tag}, ${executionId}, 'unrecorded', '{"_tag":"Success","value":"older"}', '{"via":"import"}', 3)
            `
            yield* sql`
              INSERT INTO flows_clock_deadlines (
                flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms
              ) VALUES
                (${TestFlow._tag}, ${executionId}, 'fired', 'DurableClock/fired', 10, 20),
                (${TestFlow._tag}, ${executionId}, 'pending', 'DurableClock/pending', 90, NULL),
                (${TestFlow._tag}, ${emptyRun}, 'orphan', 'DurableClock/orphan', 40, NULL)
            `
          }))
          yield* rawEvent(
            context.journal,
            executionId,
            `legacy:deferred:${JSON.stringify([TestFlow._tag, executionId, "answer"])}`,
            Fold.eventTypes.deferredCompleted,
            {
              flowName: TestFlow._tag,
              executionId,
              deferredName: "answer",
              exit: { _tag: "Success", value: "legacy" }
            }
          )
          for (const clock of [{ name: "fired", dueAtMs: 10 }, { name: "pending", dueAtMs: 90 }]) {
            yield* rawEvent(
              context.journal,
              executionId,
              `legacy:clock:${JSON.stringify([TestFlow._tag, executionId, clock.name])}`,
              Fold.eventTypes.clockScheduled,
              {
                flowName: TestFlow._tag,
                executionId,
                clockName: clock.name,
                deferredName: `DurableClock/${clock.name}`,
                dueAtMs: clock.dueAtMs
              }
            )
          }

          // The fold migration backfills one snapshot record per row.
          yield* deferredClockFold
          const before = yield* dumpTables
          const deferredSnapshots = yield* context.events(executionId, Fold.eventTypes.deferredSnapshot)
          const clockSnapshots = yield* context.events(executionId, Fold.eventTypes.clockSnapshot)
          const orphanSnapshots = yield* context.events(emptyRun, Fold.eventTypes.clockSnapshot)

          yield* writer.write(Effect.gen(function*() {
            yield* sql`DELETE FROM flows_deferred_completions`
            yield* sql`DELETE FROM flows_clock_deadlines`
          }))
          const rebuilt = yield* Fold.rebuild
          const after = yield* dumpTables
          return { before, after, rebuilt, deferredSnapshots, clockSnapshots, orphanSnapshots }
        })
      )

      expect(result.deferredSnapshots).toHaveLength(2)
      expect(result.clockSnapshots).toHaveLength(2)
      // The eventless run's row got its snapshot at sequence zero.
      expect(result.orphanSnapshots).toHaveLength(1)
      expect(result.orphanSnapshots[0]!.seq).toBe(0)
      expect(result.rebuilt).toEqual({ deferreds: 2, clocks: 3 })
      // Migrate, drop, rebuild: equivalent state — the fired clock stays
      // completed (its CAS predates the clock-completed record) and the
      // pre-fold deferred rows are exact, including the one no record named.
      expect(result.after).toEqual(result.before)
    }))
})
