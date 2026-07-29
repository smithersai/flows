import { Database as DatabaseModule, TestDatabase } from "@flows/database"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describe, expect, it } from "vitest"
import { AttemptStore } from "../src/AttemptStore.ts"
import * as AttemptStoreLive from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const migrated = <A, E>(effect: Effect.Effect<A, E, DatabaseModule.Database | AttemptStore>) =>
  run(
    effect.pipe(
      Effect.provide(AttemptStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer)
    )
  )

const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

const failingDatabase = (cause: unknown): Layer.Layer<DatabaseModule.Database> => {
  const sql = new Proxy(
    () => Effect.fail(cause),
    { apply: () => Effect.fail(cause) }
  ) as unknown as SqlClient.SqlClient
  const write: DatabaseModule.DatabaseService["write"] = (effect) => effect
  return Layer.succeed(DatabaseModule.Database)(
    DatabaseModule.Database.of({ sql, write })
  )
}

const createRun = (runId = "run-1") =>
  Effect.gen(function*() {
    const database = yield* DatabaseModule.Database
    yield* database.sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (${runId}, 'running', 1, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, '{}')
    `
  })

describe("AttemptStore", () => {
  it("round-trips an attempt and its opaque metadata", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      const meta = { discardCheckpoint: true, nested: { value: "opaque" } }
      expect(
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          heartbeatAtMs: 11,
          checkpoint: { cursor: 2 },
          meta
        }, owner)
      ).toEqual({ _tag: "Inserted" })
      return yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
    }))

    expect(Option.getOrThrow(result)).toEqual({
      runId: "run-1",
      stepKeyDigest: "digest-1",
      attempt: 0,
      state: "running",
      startedAtMs: 10,
      heartbeatAtMs: 11,
      checkpoint: { cursor: 2 },
      meta: { discardCheckpoint: true, nested: { value: "opaque" } }
    })
  })

  it("preserves opaque metadata across terminal state rewrites when no replacement is supplied", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: { discardCheckpoint: true }
      }, owner)
      expect(
        yield* store.finish({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "cancelled",
          finishedAtMs: 20,
          error: { reason: "lost" },
          outcome: { kind: "cancelled" }
        }, owner)
      ).toEqual({ _tag: "Finished" })
      return yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
    }))

    expect(Option.getOrThrow(result)).toMatchObject({
      state: "cancelled",
      meta: { discardCheckpoint: true },
      error: { reason: "lost" },
      outcome: { kind: "cancelled" }
    })
  })

  it("atomically records failure metadata discovered at the terminal transition", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: { agentChainIndex: 1 }
      }, owner)
      expect(
        yield* store.finish({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "failed",
          finishedAtMs: 20,
          meta: {
            agentChainIndex: 1,
            discardResumeSession: true
          }
        }, owner)
      ).toEqual({ _tag: "Finished" })
      return Option.getOrThrow(
        yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      )
    }))

    expect(result.meta).toEqual({
      agentChainIndex: 1,
      discardResumeSession: true
    })
  })

  it("reports FenceLost when the run owner tuple changed", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const database = yield* DatabaseModule.Database
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: {}
      }, owner)
      yield* database.sql`
        UPDATE flows_runs SET owner_host_id = 'host-b', owner_pid = 43, owner_nonce = 'nonce-b'
        WHERE run_id = 'run-1'
      `
      return yield* store.heartbeat("run-1", "digest-1", 0, owner, 30)
    }))

    expect(result).toEqual({ _tag: "FenceLost" })
  })

  it("updates a running heartbeat and checkpoint while liveness-only pulses preserve the checkpoint", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: {}
      }, owner)
      const updated = yield* store.heartbeat(
        "run-1",
        "digest-1",
        0,
        owner,
        12,
        { agentEngine: "codex", agentResume: "session-1" }
      )
      const livenessOnly = yield* store.heartbeat("run-1", "digest-1", 0, owner, 13)
      const missing = yield* store.heartbeat("run-1", "missing", 0, owner, 12)
      const missingGet = yield* store.get({
        runId: "run-1",
        stepKeyDigest: "missing",
        attempt: 0
      })
      return {
        updated,
        livenessOnly,
        missing,
        missingGet,
        stored: Option.getOrThrow(
          yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
        )
      }
    }))

    expect(result.updated).toEqual({ _tag: "Updated" })
    expect(result.livenessOnly).toEqual({ _tag: "Updated" })
    expect(result.missing).toEqual({ _tag: "NotFound" })
    expect(Option.isNone(result.missingGet)).toBe(true)
    expect(result.stored.heartbeatAtMs).toBe(13)
    expect(result.stored.checkpoint).toEqual({
      agentEngine: "codex",
      agentResume: "session-1"
    })
  })

  it("keeps multiple attempts for one step", async () => {
    const attempts = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: {}
      }, owner)
      yield* store.finish({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "failed",
        finishedAtMs: 15
      }, owner)
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 1,
        state: "running",
        startedAtMs: 20,
        meta: {}
      }, owner)
      return yield* Effect.all([
        store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 }),
        store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 1 })
      ])
    }))

    expect(attempts.map(Option.getOrThrow).map((attempt) => attempt.state)).toEqual(["failed", "running"])
  })

  it("fences attempt creation and detects divergent retries", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      const attempt = {
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: { value: 1 }
      }
      const inserted = yield* store.put(attempt, owner)
      const same = yield* store.put(attempt, owner)
      const conflict = yield* store.put({ ...attempt, meta: { value: 2 } }, owner)
      const stale = yield* store.put(
        { ...attempt, stepKeyDigest: "digest-2" },
        { hostId: "host-b", pid: 7, nonce: "stale" }
      )
      return { inserted, same, conflict, stale }
    }))

    expect(result).toEqual({
      inserted: { _tag: "Inserted" },
      same: { _tag: "ExistingSame" },
      conflict: { _tag: "Conflict" },
      stale: { _tag: "FenceLost" }
    })
  })

  it("reports RunNotFound when creating an attempt for a missing run", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* AttemptStore
      return yield* store.put({
        runId: "missing",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "running",
        startedAtMs: 0,
        meta: {}
      }, owner)
    }))

    expect(result).toEqual({ _tag: "RunNotFound" })
  })

  it("recognizes identical attempts with every optional field", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      const attempt = {
        runId: "run-1",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        finishedAtMs: 11,
        heartbeatAtMs: 12,
        checkpoint: { cursor: 1 },
        error: { message: "recorded" },
        outcome: { value: 1 },
        meta: { opaque: true }
      }
      yield* store.put(attempt, owner)
      return yield* store.put(attempt, owner)
    }))

    expect(result).toEqual({ _tag: "ExistingSame" })
  })

  it("does not heartbeat terminal attempts", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        heartbeatAtMs: 11,
        meta: {}
      }, owner)
      yield* store.finish({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "completed",
        finishedAtMs: 20,
        outcome: { ok: true }
      }, owner)
      const heartbeat = yield* store.heartbeat("run-1", "digest-1", 0, owner, 30)
      const stored = Option.getOrThrow(
        yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      )
      return { heartbeat, stored }
    }))

    expect(result.heartbeat).toEqual({ _tag: "StateChanged" })
    expect(result.stored.heartbeatAtMs).toBe(11)
  })

  it("reports missing, stale, and repeated terminal transitions", async () => {
    const result = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      const terminal = {
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "completed",
        finishedAtMs: 20,
        outcome: { value: "first" }
      }
      const missing = yield* store.finish(terminal, owner)
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        meta: {}
      }, owner)
      const stale = yield* store.finish(terminal, { hostId: "host-b", pid: 7, nonce: "stale" })
      const finished = yield* store.finish(terminal, owner)
      const repeated = yield* store.finish(
        { ...terminal, outcome: { value: "second" } },
        owner
      )
      const stored = Option.getOrThrow(
        yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      )
      return { missing, stale, finished, repeated, stored }
    }))

    expect(result.missing).toEqual({ _tag: "NotFound" })
    expect(result.stale).toEqual({ _tag: "FenceLost" })
    expect(result.finished).toEqual({ _tag: "Finished" })
    expect(result.repeated).toEqual({ _tag: "StateChanged" })
    expect(result.stored.outcome).toEqual({ value: "first" })
  })

  it("rejects invalid ids, timestamps, states, and JSON values with stable codes", async () => {
    const failures = await migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      const base = {
        runId: "run-1",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "running",
        startedAtMs: 0,
        meta: {}
      }
      const invalidPuts = [
        { ...base, runId: "" },
        { ...base, stepKeyDigest: "" },
        { ...base, attempt: Number.NaN },
        { ...base, attempt: -1 },
        { ...base, state: "" },
        { ...base, startedAtMs: Number.NaN },
        { ...base, startedAtMs: -1 },
        { ...base, finishedAtMs: Number.NaN },
        { ...base, finishedAtMs: -1 },
        { ...base, heartbeatAtMs: Number.NaN },
        { ...base, heartbeatAtMs: -1 },
        { ...base, checkpoint: undefined, meta: undefined },
        { ...base, checkpoint: BigInt(1) },
        { ...base, error: BigInt(1) },
        { ...base, outcome: BigInt(1) },
        { ...base, meta: BigInt(1) }
      ]
      const putFailures = yield* Effect.forEach(
        invalidPuts,
        (attempt) => Effect.flip(store.put(attempt, owner))
      )
      const heartbeatFailures = yield* Effect.forEach(
        [
          store.heartbeat("run-1", "digest", 0, owner, Number.NaN),
          store.heartbeat("run-1", "digest", 0, owner, -1),
          store.heartbeat("run-1", "digest", 0, owner, 1, BigInt(1)),
          store.heartbeat("run-1", "digest", 0, owner, 1, "x".repeat(1024 * 1024))
        ],
        Effect.flip
      )
      const invalidFinishes = [
        { ...base, state: "", finishedAtMs: 1 },
        { ...base, state: "running", finishedAtMs: 1 },
        { ...base, state: "completed", finishedAtMs: Number.NaN },
        { ...base, state: "completed", finishedAtMs: -1 },
        { ...base, state: "completed", finishedAtMs: 1, error: BigInt(1) },
        { ...base, state: "completed", finishedAtMs: 1, outcome: BigInt(1) },
        { ...base, state: "completed", finishedAtMs: 1, meta: BigInt(1) }
      ]
      const finishFailures = yield* Effect.forEach(
        invalidFinishes,
        (attempt) => Effect.flip(store.finish(attempt, owner))
      )
      return [...putFailures, ...heartbeatFailures, ...finishFailures]
    }))

    expect(failures.every((failure) => failure.code === "invalid_attempt")).toBe(true)
    expect(failures.every((failure) => failure.cause !== undefined)).toBe(false)
    expect(failures.some((failure) => failure.cause !== undefined)).toBe(true)
  })

  it("reports decode_failed for corrupt durable attempt JSON", async () => {
    const codes = await migrated(Effect.gen(function*() {
      yield* createRun()
      const database = yield* DatabaseModule.Database
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "running",
        startedAtMs: 0,
        meta: {}
      }, owner)
      const codes: Array<string> = []
      for (const column of ["checkpoint_json", "error_json", "outcome_json", "meta_json"] as const) {
        yield* database.sql.unsafe(
          `UPDATE flows_attempts SET ${column} = 'not-json' WHERE run_id = 'run-1'`
        )
        const failure = yield* Effect.flip(
          store.get({ runId: "run-1", stepKeyDigest: "digest", attempt: 0 })
        )
        codes.push(failure.code)
        yield* database.sql.unsafe(
          `UPDATE flows_attempts SET ${column} = ${column === "meta_json" ? "'{}'" : "NULL"} WHERE run_id = 'run-1'`
        )
      }
      return codes
    }))

    expect(codes).toEqual(["decode_failed", "decode_failed", "decode_failed", "decode_failed"])
  })

  it("decodes complete durable attempt rows before exposing numeric or state fields", async () => {
    const codes = await migrated(Effect.gen(function*() {
      yield* createRun()
      const database = yield* DatabaseModule.Database
      const store = yield* AttemptStore
      yield* store.put({
        runId: "run-1",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "running",
        startedAtMs: 0,
        heartbeatAtMs: 1,
        meta: {}
      }, owner)
      const corruptions = [
        ["state", "''", "'running'"],
        ["started_at_ms", "'bad'", "0"],
        ["finished_at_ms", "-1", "NULL"],
        ["heartbeat_at_ms", "'bad'", "1"]
      ] as const
      return yield* Effect.forEach(corruptions, ([column, value, restore]) =>
        Effect.gen(function*() {
          yield* database.sql.unsafe(
            `UPDATE flows_attempts SET ${column} = ${value} WHERE run_id = 'run-1'`
          )
          const failure = yield* Effect.flip(
            store.get({ runId: "run-1", stepKeyDigest: "digest", attempt: 0 })
          )
          yield* database.sql.unsafe(
            `UPDATE flows_attempts SET ${column} = ${restore} WHERE run_id = 'run-1'`
          )
          return failure.code
        }))
    }))

    expect(codes).toEqual(["decode_failed", "decode_failed", "decode_failed", "decode_failed"])
  })

  it("normalizes persistence failures into stable error codes", async () => {
    const existing = new AttemptStoreLive.AttemptStoreError({
      code: "unknown",
      message: "existing"
    })
    const causes: ReadonlyArray<unknown> = [
      existing,
      new SqlError.SqlError({
        reason: new SqlError.ConstraintError({ cause: new Error("constraint") })
      }),
      new SqlError.SqlError({
        reason: new SqlError.UniqueViolation({ cause: new Error("unique"), constraint: "attempt" })
      }),
      new DatabaseModule.DatabaseError({ code: "constraint" }),
      { code: "other" },
      {},
      null,
      "failure"
    ]
    const codes = await Effect.runPromise(
      Effect.forEach(
        causes,
        (cause) =>
          Effect.gen(function*() {
            const store = yield* AttemptStore
            return (yield* Effect.flip(
              store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 })
            )).code
          }).pipe(
            Effect.provide(AttemptStoreLive.layer),
            Effect.provide(failingDatabase(cause))
          )
      )
    )

    expect(codes).toEqual([
      "unknown",
      "constraint",
      "constraint",
      "constraint",
      "persistence_failed",
      "persistence_failed",
      "persistence_failed",
      "persistence_failed"
    ])
  })
})
