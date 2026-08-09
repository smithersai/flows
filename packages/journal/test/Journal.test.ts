import { Database, DatabaseError, type DatabaseService } from "@smthrs/database/Database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { describe, expect, it } from "vitest"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, makeEventId, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown,
  sequence?: SourceSeq
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    ...(sequence === undefined ? {} : { sourceSeq: sequence }),
    eventType,
    payload
  }, { disableChecks: true })

const migratedDatabase = (database: Layer.Layer<Database> = TestDatabase.layer) =>
  Layer.provideMerge(Migrations.layer, database)

const journalLayer = (
  options: SqlJournal.SqlJournalOptions,
  database: Layer.Layer<Database> = TestDatabase.layer
) => SqlJournal.layer(options).pipe(Layer.provide(migratedDatabase(database)))

const runJournal = <A, E>(
  effect: Effect.Effect<A, E, Journal | Scope.Scope>,
  options: SqlJournal.SqlJournalOptions = {
    capacity: 128,
    overflow: "reject"
  }
) =>
  effect.pipe(
    Effect.provide(journalLayer(options)),
    Effect.scoped
  )

const gateWrites = (gate: Deferred.Deferred<void>): Layer.Layer<Database, never, Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      const write: DatabaseService["write"] = (effect) =>
        Deferred.await(gate).pipe(Effect.andThen(database.write(effect)))
      return Database.of({ sql: database.sql, write })
    })
  )

const gatedDatabase = (gate: Deferred.Deferred<void>): Layer.Layer<Database> =>
  gateWrites(gate).pipe(Layer.provide(TestDatabase.layer))

const failedDatabase: Layer.Layer<Database> = Layer.effect(
  Database,
  Effect.gen(function*() {
    const database = yield* Database
    const write: DatabaseService["write"] = () =>
      Effect.fail(
        new DatabaseError({
          code: "io",
          cause: new Error("sink unavailable")
        })
      )
    return Database.of({ sql: database.sql, write })
  })
).pipe(Layer.provide(TestDatabase.layer))

const failedDatabaseWithReadSignal = (
  readStarted: Deferred.Deferred<void>
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      const sql = new Proxy(database.sql, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (typeof statement.compile !== "function") {
            return statement
          }
          const [query] = statement.compile()
          return query.includes("FROM flows_journal_events") && query.includes("seq >")
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(statement))
            : statement
        }
      }) as SqlClient.SqlClient
      const write: DatabaseService["write"] = () =>
        Effect.fail(new DatabaseError({ code: "io", cause: new Error("sink unavailable") }))
      return Database.of({ sql, write })
    })
  ).pipe(Layer.provide(TestDatabase.layer))

/**
 * A database whose writes fail until `repair` is called, modelling a transient
 * persistence outage that the queued writer fiber observes and that later
 * clears.
 */
const transientlyFailingDatabase = (): {
  readonly layer: Layer.Layer<Database>
  repair: () => void
} => {
  let broken = true
  return {
    repair: () => {
      broken = false
    },
    layer: Layer.effect(
      Database,
      Effect.gen(function*() {
        const database = yield* Database
        const write: DatabaseService["write"] = (effect) =>
          broken
            ? Effect.fail(new DatabaseError({ code: "io", cause: new Error("sink unavailable") }))
            : database.write(effect)
        return Database.of({ sql: database.sql, write })
      })
    ).pipe(Layer.provide(TestDatabase.layer))
  }
}

const defectDatabase: Layer.Layer<Database> = Layer.effect(
  Database,
  Effect.gen(function*() {
    const database = yield* Database
    const write: DatabaseService["write"] = () => Effect.die("sink defect")
    return Database.of({ sql: database.sql, write })
  })
).pipe(Layer.provide(TestDatabase.layer))

interface InitializationOverride {
  readonly sequences?:
    | ReadonlyArray<{
      readonly run_id: string
      readonly next_seq: unknown
    }>
    | undefined
  readonly sourceSequences?:
    | ReadonlyArray<{
      readonly run_id: string
      readonly source_id: string
      readonly next_source_seq: unknown
    }>
    | undefined
  readonly sourceEvents?:
    | ReadonlyArray<{
      readonly run_id: string
      readonly seq: unknown
      readonly event_id: string
      readonly source_id: string
      readonly source_seq: unknown
      readonly emitted_at_ms: number
      readonly event_type: string
      readonly payload_json: string
      readonly meta_json: string
    }>
    | undefined
  readonly failSequences?: boolean | undefined
  readonly failSourceSequences?: boolean | undefined
  readonly failSourceEvents?: boolean | undefined
}

const overrideInitialization = (
  override: InitializationOverride
): Layer.Layer<Database, never, Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      const sql = new Proxy(database.sql, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (query.includes("MAX(seq) + 1")) {
            if (override.failSequences === true) {
              return Effect.fail(new DatabaseError({ code: "io" }))
            }
            if (override.sequences !== undefined) {
              return Effect.succeed(override.sequences)
            }
          }
          if (query.includes("MAX(source_seq) + 1")) {
            if (override.failSourceSequences === true) {
              return Effect.fail(new DatabaseError({ code: "io" }))
            }
            if (override.sourceSequences !== undefined) {
              return Effect.succeed(override.sourceSequences)
            }
          }
          if (
            query.includes("FROM flows_journal_events") &&
            !query.includes("MAX(") &&
            !query.includes("WHERE")
          ) {
            if (override.failSourceEvents === true) {
              return Effect.fail(new DatabaseError({ code: "io" }))
            }
            if (override.sourceEvents !== undefined) {
              return Effect.succeed(override.sourceEvents)
            }
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return Database.of({ sql, write: database.write })
    })
  )

const racedDuplicateDatabase = (
  duplicateRunId: RunId,
  duplicateSourceId: SourceId,
  duplicateSourceSeq: SourceSeq
): Layer.Layer<Database, never, Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      let armed = true
      const sql = new Proxy(database.sql, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (armed && query.includes("INSERT INTO flows_journal_events")) {
            armed = false
            return database.sql`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${duplicateRunId}, 0,
                ${makeEventId(duplicateRunId, duplicateSourceId, duplicateSourceSeq)},
                ${duplicateSourceId}, ${duplicateSourceSeq}, 0,
                'event', '{"value":1}', 'null'
              )
            `.pipe(Effect.andThen(statement))
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return Database.of({ sql, write: database.write })
    })
  )

const preflightDuplicateDatabase = (
  duplicateRunId: RunId,
  duplicateSourceId: SourceId,
  duplicateSourceSeq: SourceSeq,
  payloadJson: string
): Layer.Layer<Database, never, Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      let armed = true
      const sql = new Proxy(database.sql, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (armed && query.includes("WHERE event_id")) {
            armed = false
            return database.sql`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${duplicateRunId}, 0,
                ${makeEventId(duplicateRunId, duplicateSourceId, duplicateSourceSeq)},
                ${duplicateSourceId}, ${duplicateSourceSeq}, 0,
                'event', ${payloadJson}, 'null'
              )
            `.pipe(Effect.andThen(statement))
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return Database.of({ sql, write: database.write })
    })
  )

interface ReadGate {
  armed: boolean
  readonly release: Deferred.Deferred<void>
  readonly started: Deferred.Deferred<void>
}

const readGatedDatabase = (gate: ReadGate): Layer.Layer<Database, never, Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      const sql = new Proxy(database.sql, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (
            !gate.armed ||
            !query.includes("FROM flows_journal_events") ||
            !query.includes("seq >")
          ) {
            return statement
          }
          gate.armed = false
          return Deferred.succeed(gate.started, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
            Effect.andThen(statement)
          )
        }
      }) as SqlClient.SqlClient
      return Database.of({
        sql,
        write: database.write
      })
    })
  )

describe("Journal", () => {
  effect("validates queue and batch options when constructing the layer", () =>
    Effect.gen(function*() {
      const failures = yield* Effect.forEach(
        [
          { capacity: 0, overflow: "reject" as const },
          { capacity: Number.NaN, overflow: "reject" as const },
          { capacity: 1, overflow: "reject" as const, batchSize: 0 },
          { capacity: 1, overflow: "reject" as const, batchSize: Number.NaN }
        ],
        (options) =>
          Effect.flip(
            Effect.scoped(
              Effect.gen(function*() {
                yield* Journal
              }).pipe(Effect.provide(journalLayer(options)))
            )
          )
      )
      expect(failures.every((failure) => failure instanceof JournalError)).toBe(true)
      expect(failures.map((failure) => failure instanceof JournalError ? failure.code : undefined)).toEqual([
        "invalid_event",
        "invalid_event",
        "invalid_event",
        "invalid_event"
      ])
    }))

  effect(
    "normalizes initialization failures and rejects invalid durable sequence cursors",
    () =>
      Effect.gen(function*() {
        const acquire = (override: InitializationOverride) =>
          Effect.flip(
            Effect.scoped(
              Effect.gen(function*() {
                yield* Journal
              }).pipe(
                Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
                Effect.provide(overrideInitialization(override)),
                Effect.provide(migratedDatabase())
              )
            )
          )
        const durableSourceEvent = (seq: number, durableSourceSeq: number) => ({
          run_id: "run",
          seq,
          event_id: "event-id",
          source_id: "source",
          source_seq: durableSourceSeq,
          emitted_at_ms: 0,
          event_type: "event",
          payload_json: "{}",
          meta_json: "null"
        })
        const failures = yield* Effect.all([
          acquire({ failSequences: true }),
          acquire({ sequences: [], failSourceSequences: true }),
          acquire({
            sequences: [],
            sourceSequences: [],
            failSourceEvents: true
          }),
          acquire({
            sequences: [{ run_id: "run", next_seq: Number.NaN }],
            sourceSequences: []
          }),
          acquire({
            sequences: [{ run_id: "run", next_seq: -1 }],
            sourceSequences: []
          }),
          acquire({
            sequences: [],
            sourceSequences: [{
              run_id: "run",
              source_id: "source",
              next_source_seq: Number.NaN
            }]
          }),
          acquire({
            sequences: [],
            sourceSequences: [{
              run_id: "run",
              source_id: "source",
              next_source_seq: -1
            }]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(Number.MAX_SAFE_INTEGER + 1, 0)]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(0, Number.MAX_SAFE_INTEGER + 1)]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(Number.MAX_SAFE_INTEGER, 0)]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(0, Number.MAX_SAFE_INTEGER)]
          })
        ])
        expect(failures.every((failure) => failure instanceof JournalError)).toBe(true)
        expect(failures.map((failure) => failure instanceof JournalError ? failure.code : undefined)).toEqual([
          "sink_failed",
          "sink_failed",
          "sink_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed"
        ])
      })
  )

  effect("continues sequence allocation from valid durable cursors", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const receipt = yield* journal.emit(
          input(runId("continued"), sourceId("source"), "event", {})
        )
        expect(receipt).toMatchObject({ seq: 4, sourceSeq: 7 })
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [{ run_id: "continued", next_seq: 4 }],
          sourceSequences: [{
            run_id: "continued",
            source_id: "source",
            next_source_seq: 7
          }]
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("restores committed source identities for duplicate receipts", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const receipt = yield* journal.emit(
          input(runId("restored"), sourceId("source"), "event", { value: 1 }, sourceSeq(5))
        )
        expect(receipt).toEqual({
          _tag: "Duplicate",
          seq: 3,
          sourceSeq: 5,
          status: "committed"
        })
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [{ run_id: "restored", next_seq: 4 }],
          sourceSequences: [{
            run_id: "restored",
            source_id: "source",
            next_source_seq: 6
          }],
          sourceEvents: [{
            run_id: "restored",
            seq: 3,
            event_id: "event-id",
            source_id: "source",
            source_seq: 5,
            emitted_at_ms: 0,
            event_type: "event",
            payload_json: "{\"value\":1}",
            meta_json: "null"
          }]
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("rejects an exhausted canonical sequence cursor at emit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failure = yield* Effect.flip(
          journal.emit(input(runId("exhausted"), sourceId("source"), "event", {}))
        )
        expect(failure.code).toBe("invalid_event")
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [{
            run_id: "exhausted",
            next_seq: Number.MAX_SAFE_INTEGER
          }],
          sourceSequences: [],
          sourceEvents: []
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("validates emitted envelopes, JSON values, sequence bounds, and clock time", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const validRun = runId("valid")
        const validSource = sourceId("source")
        const invalidInputs = [
          input(runId(""), validSource, "event", {}),
          input(validRun, sourceId(""), "event", {}),
          input(validRun, validSource, "", {}),
          input(validRun, validSource, "event", undefined),
          input(validRun, validSource, "event", BigInt(1)),
          new Input({
            runId: validRun,
            sourceId: validSource,
            eventType: "event",
            payload: {},
            meta: BigInt(1)
          }, { disableChecks: true }),
          input(validRun, validSource, "event", {}, sourceSeq(-1)),
          input(validRun, validSource, "event", {}, sourceSeq(Number.NaN)),
          input(validRun, validSource, "event", {}, sourceSeq(Number.MAX_SAFE_INTEGER)),
          {} as Input
        ]
        const failures = yield* Effect.forEach(
          invalidInputs,
          (invalid) => Effect.flip(journal.emit(invalid))
        )
        yield* TestClock.setTime(-1)
        failures.push(
          yield* Effect.flip(
            journal.emit(input(validRun, validSource, "event", {}))
          )
        )
        expect(failures.every((failure) => failure.code === "invalid_event")).toBe(true)
      })
    ))

  effect("validates durable read cursors", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failures = yield* Effect.all([
          Effect.flip(journal.entries({ runId: runId(""), limit: 1 })),
          Effect.flip(journal.entries({ runId: runId("run"), limit: 0 })),
          Effect.flip(journal.entries({ runId: runId("run"), limit: Number.NaN })),
          Effect.flip(journal.entries({
            runId: runId("run"),
            after: -2 as Seq,
            limit: 1
          })),
          Effect.flip(journal.entries({
            runId: runId("run"),
            after: Number.NaN as Seq,
            limit: 1
          }))
        ])
        expect(failures.every((failure) => failure.code === "invalid_event")).toBe(true)
      })
    ))

  effect("returns from emit before persistence", () => {
    const gate = Deferred.makeUnsafe<void>()
    const run = runId("nonblocking")
    const source = sourceId("producer")

    return Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const journal = yield* Journal
      const receipt = yield* journal.emit(input(run, source, "read.completed", { path: "a" }))
      expect(receipt).toMatchObject({ _tag: "Accepted", seq: 0, sourceSeq: 0 })

      const before = yield* journal.entries({ runId: run, limit: 10 })
      expect(before.entries).toEqual([])

      const flushFiber = yield* Effect.forkChild(journal.flush, { startImmediately: true })
      yield* Effect.yieldNow
      expect(flushFiber.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(flushFiber)
      const after = yield* journal.entries({ runId: run, limit: 10 })
      expect(after.entries).toHaveLength(1)
      expect(after.entries[0]?.emittedAtMs).toBe(1_000)
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.provide(journalLayer({ capacity: 4, overflow: "reject" }, gatedDatabase(gate))),
      Effect.scoped
    )
  })

  effect("allocates canonical run sequences before admission across producers", () => {
    const firstRun = runId("source-sequences-a")
    const secondRun = runId("source-sequences-b")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const receipts = yield* Effect.forEach([
          [firstRun, sourceId("producer-a"), "one", 1] as const,
          [firstRun, sourceId("producer-b"), "two", 2] as const,
          [firstRun, sourceId("producer-a"), "three", 3] as const,
          [secondRun, sourceId("producer-a"), "one", 1] as const
        ], ([run, source, eventType, payload]) => journal.emit(input(run, source, eventType, payload)))
        expect(receipts).toMatchObject([
          { _tag: "Accepted", seq: 0, sourceSeq: 0 },
          { _tag: "Accepted", seq: 1, sourceSeq: 0 },
          { _tag: "Accepted", seq: 2, sourceSeq: 1 },
          { _tag: "Accepted", seq: 0, sourceSeq: 0 }
        ])

        yield* journal.flush
        const entries = yield* journal.entries({ runId: firstRun, limit: 10 })
        expect(entries.entries.map((entry) => entry.seq)).toEqual([0, 1, 2])
        expect(entries.entries.map((entry) => entry.sourceSeq)).toEqual([0, 0, 1])
      })
    )
  })

  effect("serializes concurrent producers without duplicate canonical sequences", () => {
    const run = runId("concurrent")
    const work = Array.from({ length: 50 }, (_, index) => index)

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          work,
          (index) =>
            journal.emit(
              input(
                run,
                sourceId(index % 2 === 0 ? "producer-a" : "producer-b"),
                "concurrent.event",
                { index }
              )
            ),
          { concurrency: "unbounded", discard: true }
        )
        yield* journal.flush
        const page = yield* journal.entries({ runId: run, limit: 100 })
        const sequences = page.entries.map((entry) => entry.seq)
        expect(sequences).toEqual(work)
        expect(new Set(sequences).size).toBe(work.length)
      }),
      { capacity: 128, overflow: "reject", batchSize: 8 }
    )
  })

  effect("makes reject, drop-newest, and drop-oldest observable", () =>
    Effect.forEach(
      ["reject", "drop-newest", "drop-oldest"] as const,
      (policy) => {
        const gate = Deferred.makeUnsafe<void>()
        const run = runId(`overflow-${policy}`)
        const source = sourceId("producer")
        return Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emit(input(run, source, "event", { value: 1 }))
          yield* Effect.yieldNow
          yield* journal.emit(input(run, source, "event", { value: 2 }))

          if (policy === "reject") {
            const failure = yield* Effect.flip(
              journal.emit(input(run, source, "event", { value: 3 }))
            )
            expect(failure.code).toBe("queue_overflow")
          } else {
            const receipt = yield* journal.emit(input(run, source, "event", { value: 3 }))
            expect(receipt).toMatchObject(
              policy === "drop-newest"
                ? { _tag: "Dropped", seq: 2, sourceSeq: 2, policy: "drop-newest" }
                : {
                  _tag: "Accepted",
                  seq: 2,
                  sourceSeq: 2,
                  evicted: { policy: "drop-oldest", count: 1 }
                }
            )
          }

          yield* Deferred.succeed(gate, undefined)
          yield* journal.flush
          const page = yield* journal.entries({ runId: run, limit: 10 })
          expect(page.entries.map((entry) => entry.seq)).toEqual(
            policy === "drop-oldest" ? [0, 2] : [0, 1]
          )
          expect(page.entries.map((entry) => entry.sourceSeq)).toEqual(
            policy === "drop-oldest" ? [0, 2] : [0, 1]
          )
        }).pipe(
          Effect.ensuring(Deferred.succeed(gate, undefined)),
          Effect.provide(
            journalLayer(
              { capacity: 1, overflow: policy, batchSize: 1 },
              gatedDatabase(gate)
            )
          ),
          Effect.scoped
        )
      },
      { discard: true }
    ))

  effect("persists telemetry events through the same queue and changes subscription", () => {
    const run = runId("telemetry")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const subscription = yield* journal.changes
        const changed = yield* Effect.forkChild(PubSub.take(subscription), {
          startImmediately: true
        })
        yield* journal.emit(
          input(run, sourceId("telemetry"), "telemetry.span", {
            durationMs: 4
          })
        )
        yield* journal.flush

        const notification = yield* Fiber.join(changed)
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(notification.eventType).toBe("telemetry.span")
        expect(page.entries).toHaveLength(1)
        expect(page.entries[0]?.eventId).toBe(notification.eventId)
      })
    )
  })

  effect("closes the replay-then-live subscription race without loss or duplication", () => {
    const run = runId("replay-live")
    const source = sourceId("producer")
    const gate: ReadGate = {
      armed: false,
      release: Deferred.makeUnsafe<void>(),
      started: Deferred.makeUnsafe<void>()
    }
    const database = readGatedDatabase(gate).pipe(
      Layer.provide(migratedDatabase())
    )

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emit(input(run, source, "historical", { value: 1 }))
      yield* journal.flush

      yield* Effect.sync(() => {
        gate.armed = true
      })
      const collected = yield* journal.stream({ runId: run }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(gate.started)
      yield* journal.emit(input(run, source, "live", { value: 2 }))
      yield* journal.flush
      yield* Deferred.succeed(gate.release, undefined)

      const entries = yield* Fiber.join(collected)
      expect(entries.map((entry) => entry.seq)).toEqual([0, 1])
      expect(new Set(entries.map((entry) => entry.eventId)).size).toBe(2)
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate.release, undefined)),
      Effect.provide(
        SqlJournal.layer({
          capacity: 128,
          overflow: "reject"
        }).pipe(Layer.provide(database))
      ),
      Effect.scoped
    )
  })

  effect("replays after an explicit cursor and drains multiple internal pages", () => {
    const run = runId("stream-cursor")
    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          [0, 1, 2],
          (value) => journal.emit(input(run, sourceId("producer"), "event", { value })),
          { discard: true }
        )
        yield* journal.flush
        const entries = yield* journal.stream({
          runId: run,
          afterSequence: 0 as Seq
        }).pipe(Stream.take(2), Stream.runCollect)
        expect(entries.map((entry) => entry.seq)).toEqual([1, 2])
      }),
      { capacity: 4, overflow: "reject", batchSize: 1 }
    )
  })

  effect("keeps a shared run subscription until its final consumer closes", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const first = yield* journal.stream({ runId: runId("shared-subscription") }).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        const second = yield* journal.stream({ runId: runId("shared-subscription") }).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(first)
        yield* Fiber.interrupt(second)
      })
    ))

  effect("reads durable entries in pages", () => {
    const run = runId("paging")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          [0, 1, 2, 3, 4],
          (value) => journal.emit(input(run, source, "paged", { value })),
          { discard: true }
        )
        yield* journal.flush

        const first = yield* journal.entries({ runId: run, limit: 2 })
        const second = yield* journal.entries({
          runId: run,
          after: first.entries.at(-1)!.seq,
          limit: 2
        })
        const third = yield* journal.entries({
          runId: run,
          after: second.entries.at(-1)!.seq,
          limit: 2
        })
        expect(first).toMatchObject({ hasMore: true })
        expect(second).toMatchObject({ hasMore: true })
        expect(third).toMatchObject({ hasMore: false })
        expect(
          [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.seq)
        ).toEqual([0, 1, 2, 3, 4])
      })
    )
  })

  effect("reports each lost batch once and keeps accepting work while the sink is down", () => {
    const run = runId("sink-failure")
    const source = sourceId("producer")

    return Effect.gen(function*() {
      const journal = yield* Journal
      const receipt = yield* journal.emit(input(run, source, "event", {}))
      expect(receipt._tag).toBe("Accepted")

      const flushFailure = yield* Effect.flip(journal.flush)
      expect(flushFailure.code).toBe("sink_failed")
      // The loss is spent: a flush with nothing outstanding has nothing to
      // report and must not re-raise a stale failure.
      yield* journal.flush
      // The writer survived, so the channel still admits work — and the next
      // lost batch is reported on its own flush.
      const later = yield* journal.emit(input(run, source, "later", {}))
      expect(later._tag).toBe("Accepted")
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject" }, failedDatabase)
      ),
      Effect.scoped
    )
  })

  effect("keeps the durable channel writable after a lossy sink failure", () => {
    const run = runId("sink-failure-durable")
    const source = sourceId("producer")
    const database = transientlyFailingDatabase()

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emit(input(run, source, "queued", {}))
      // The queued writer loses the batch on the transient outage.
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      // The database recovers; the lossless lifecycle channel must recover too.
      database.repair()
      const receipt = yield* journal.emitDurable(input(run, source, "lifecycle", {}))
      expect(receipt._tag).toBe("Accepted")
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["lifecycle"])
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject", allocation: "memory" }, database.layer)
      ),
      Effect.scoped
    )
  })

  effect("wakes live stream consumers when the sink fails", () => {
    const run = runId("sink-failure-stream")
    const readStarted = Deferred.makeUnsafe<void>()
    return Effect.gen(function*() {
      const journal = yield* Journal
      const consumer = yield* journal.stream({ runId: run }).pipe(
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(readStarted)
      yield* journal.emit(input(run, sourceId("producer"), "event", {}))
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
      expect((yield* Effect.flip(Fiber.join(consumer))).code).toBe("sink_failed")
    }).pipe(
      Effect.provide(
        journalLayer(
          { capacity: 4, overflow: "reject" },
          failedDatabaseWithReadSignal(readStarted)
        )
      ),
      Effect.scoped
    )
  })

  effect("recovers the lossy writer after a transient sink outage", () => {
    const run = runId("sink-failure-recovers")
    const source = sourceId("producer")
    const database = transientlyFailingDatabase()

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, source, "lost", {}))
      // Let the writer lose the batch with nobody waiting on it: the loss must
      // still reach the next flush rather than vanish.
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* Effect.yieldNow
      }
      // The outage is reported once, to the first flush after it.
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      // The latch must not survive the outage: once the database recovers the
      // queued writer keeps draining and `flush` — which durable delivery in
      // engine-store calls with `orDie` — succeeds again.
      database.repair()
      const receipt = yield* journal.emitLossy(input(run, source, "written", {}))
      expect(receipt._tag).toBe("Accepted")
      yield* journal.flush
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["written"])
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject", allocation: "memory" }, database.layer)
      ),
      Effect.scoped
    )
  })

  effect("never vouches for entries still queued behind a lost batch", () => {
    const run = runId("sink-failure-queued-behind")
    const source = sourceId("producer")
    const gate = Deferred.makeUnsafe<void>()
    // Loses the first batch, then holds every later batch at `gate`, so the
    // entries queued behind the loss are provably still unpersisted while the
    // flush under test runs.
    const database = Layer.effect(
      Database,
      Effect.gen(function*() {
        const inner = yield* Database
        let first = true
        const write: DatabaseService["write"] = (effect) => {
          if (first) {
            first = false
            return Effect.fail(new DatabaseError({ code: "io", cause: new Error("sink unavailable") }))
          }
          return Deferred.await(gate).pipe(Effect.andThen(inner.write(effect)))
        }
        return Database.of({ sql: inner.sql, write })
      })
    ).pipe(Layer.provide(TestDatabase.layer))

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, source, "lost", {}))
      yield* journal.emitLossy(input(run, source, "queued", {}))
      // Let the writer lose the first batch and block on the second.
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* Effect.yieldNow
      }
      // The loss is reported once, to this flush.
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      // The writer survived the loss and still holds `queued`, so the next
      // flush must not claim durability for it.
      const pendingFlush = yield* journal.flush.pipe(Effect.forkChild({ startImmediately: true }))
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* Effect.yieldNow
      }
      expect(pendingFlush.pollUnsafe()).toBe(undefined)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(pendingFlush)
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["queued"])

      // The counter is not desynchronized either: a later entry still gets a
      // truthful flush.
      yield* journal.emitLossy(input(run, source, "after", {}))
      yield* journal.flush
      const after = yield* journal.entries({ runId: run, limit: 10 })
      expect(after.entries.map((entry) => entry.eventType)).toEqual(["queued", "after"])
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 8, overflow: "reject", allocation: "memory", batchSize: 1 }, database)
      ),
      Effect.scoped
    )
  })

  effect("converts writer defects to sink_failed", () => {
    const run = runId("sink-defect")
    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emit(input(run, sourceId("producer"), "event", {}))
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject" }, defectDatabase)
      ),
      Effect.scoped
    )
  })

  effect("reports closed operations after the journal scope ends", () =>
    Effect.gen(function*() {
      const closed = yield* Effect.scoped(
        Effect.gen(function*() {
          return yield* Journal
        }).pipe(Effect.provide(journalLayer({ capacity: 1, overflow: "reject" })))
      )
      expect((yield* Effect.flip(closed.flush)).code).toBe("journal_closed")
      expect(
        (yield* Effect.flip(
          closed.emit(input(runId("closed"), sourceId("source"), "event", {}))
        )).code
      ).toBe("journal_closed")
    }))

  effect("drains accepted events when the journal scope closes", () => {
    const run = runId("scope-drain")
    const gate = Deferred.makeUnsafe<void>()
    const emitted = Deferred.makeUnsafe<void>()

    return Effect.gen(function*() {
      const database = yield* Database
      const closing = yield* Effect.scoped(
        Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emit(
            input(run, sourceId("producer"), "before-close", { ok: true })
          )
          yield* Deferred.succeed(emitted, undefined)
        }).pipe(
          Effect.provide(
            SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
              Layer.provide(gateWrites(gate))
            )
          )
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(emitted)
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(closing)
      const rows = yield* database.sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = ${run}
        `
      expect(rows.map((row) => row.seq)).toEqual([0])
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.provide(migratedDatabase()),
      Effect.scoped
    )
  })

  effect("deduplicates a retried source event id", () => {
    const run = runId("dedupe")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const retried = input(run, source, "retried", { value: 1 }, sourceSeq(5))
        const accepted = yield* journal.emit(retried)
        const pendingDuplicate = yield* journal.emit(retried)
        yield* journal.flush
        const committedDuplicate = yield* journal.emit(retried)

        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(accepted).toMatchObject({
          _tag: "Accepted",
          seq: 0,
          sourceSeq: 5
        })
        expect(pendingDuplicate).toEqual({
          _tag: "Duplicate",
          seq: 0,
          sourceSeq: 5,
          status: "pending"
        })
        expect(committedDuplicate).toEqual({
          _tag: "Duplicate",
          seq: 0,
          sourceSeq: 5,
          status: "committed"
        })
        expect(page.entries).toHaveLength(1)
        expect(page.entries[0]).toMatchObject({
          seq: 0 as Seq,
          sourceSeq: 5
        })
      })
    )
  })

  effect("recognizes a duplicate committed between the preflight read and insert", () => {
    const duplicateRunId = runId("raced-dedupe")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emit(
        input(duplicateRunId, duplicateSourceId, "event", { value: 1 }, duplicateSourceSeq)
      )
      yield* journal.flush
      const page = yield* journal.entries({ runId: duplicateRunId, limit: 10 })
      expect(page.entries).toHaveLength(1)
      expect(page.entries[0]?.sourceSeq).toBe(5)
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            racedDuplicateDatabase(
              duplicateRunId,
              duplicateSourceId,
              duplicateSourceSeq
            ).pipe(Layer.provide(migratedDatabase()))
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("recognizes a matching external commit during the writer preflight", () => {
    const duplicateRunId = runId("preflight-dedupe")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      const event = input(
        duplicateRunId,
        duplicateSourceId,
        "event",
        { value: 1 },
        duplicateSourceSeq
      )
      yield* journal.emit(event)
      yield* journal.flush
      expect(yield* journal.emit(event)).toEqual({
        _tag: "Duplicate",
        seq: 0,
        sourceSeq: 5,
        status: "committed"
      })
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            preflightDuplicateDatabase(
              duplicateRunId,
              duplicateSourceId,
              duplicateSourceSeq,
              "{\"value\":1}"
            ).pipe(Layer.provide(migratedDatabase()))
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("rejects a divergent external commit during the writer preflight", () => {
    const duplicateRunId = runId("preflight-conflict")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emit(
        input(
          duplicateRunId,
          duplicateSourceId,
          "event",
          { value: 1 },
          duplicateSourceSeq
        )
      )
      expect((yield* Effect.flip(journal.flush)).code).toBe("idempotency_conflict")
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            preflightDuplicateDatabase(
              duplicateRunId,
              duplicateSourceId,
              duplicateSourceSeq,
              "{\"value\":2}"
            ).pipe(Layer.provide(migratedDatabase()))
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("fails loudly when an idempotency key is reused with divergent content", () => {
    const run = runId("dedupe-conflict")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emit(input(run, source, "retried", { value: 1 }, sourceSeq(5)))
        yield* journal.flush
        const failure = yield* Effect.flip(
          journal.emit(input(run, source, "retried", { value: 2 }, sourceSeq(5)))
        )
        expect(failure.code).toBe("idempotency_conflict")
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries.map((entry) => entry.payload)).toEqual([{ value: 1 }])
      })
    )
  })

  effect("reports sequence conflicts introduced by another writer after initialization", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const database = yield* Database
        const journal = yield* Journal
        yield* database.sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'sequence-conflict', 0, 'external', 'external', 0, 0,
            'external', '{}', 'null'
          )
        `
        yield* journal.emit(
          input(runId("sequence-conflict"), sourceId("producer"), "event", {})
        )
        expect((yield* Effect.flip(journal.flush)).code).toBe("sequence_conflict")
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 4, overflow: "reject" })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("rejects corrupt durable journal rows with decode_failed", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const database = yield* Database
        const journal = yield* Journal
        yield* database.sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'corrupt-json', 0, 'corrupt-json', 'source', 0, 0,
            'event', 'not-json', 'null'
          )
        `
        const invalidJson = yield* Effect.flip(
          journal.entries({ runId: runId("corrupt-json"), limit: 1 })
        )
        yield* database.sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'corrupt-schema', 0, 'corrupt-schema', 'source', -1, 0,
            'event', '{}', 'null'
          )
        `
        const invalidSchema = yield* Effect.flip(
          journal.entries({ runId: runId("corrupt-schema"), limit: 1 })
        )
        expect([invalidJson.code, invalidSchema.code]).toEqual([
          "decode_failed",
          "decode_failed"
        ])
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 4, overflow: "reject" })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("normalizes SQL read failures", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const database = yield* Database
        const journal = yield* Journal
        yield* database.sql`DROP TABLE flows_journal_events`
        const failure = yield* Effect.flip(
          journal.entries({ runId: runId("missing-table"), limit: 1 })
        )
        expect(failure.code).toBe("unknown")
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 4, overflow: "reject" })),
        Effect.provide(migratedDatabase())
      )
    ))
})
