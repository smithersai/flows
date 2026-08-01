import { Database, TestDatabase } from "@smithers/database"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly sql: string | null
  readonly type: "index" | "table"
}

interface TableInfoRow {
  readonly name: string
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const migrated = <A, E>(effect: Effect.Effect<A, E, Database.Database>) =>
  run(effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer)))

describe("journal migrations", () => {
  it("migrates a fresh database and reruns idempotently", async () => {
    await migrated(Effect.gen(function*() {
      yield* Migrations.run
      yield* Migrations.run
    }))
  })

  it("evolves a populated database across every later migration", async () => {
    const result = await run(
      Effect.gen(function*() {
        const database = yield* Database.Database
        // Stop at the last migration a shipped database could already be on,
        // then fill every table an ALTER TABLE could break.
        yield* Migrations.runThrough("0002_durable_engine_state")
        yield* database.sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('run-done', 'completed', 1, '{"carried":true}')
        `
        yield* database.sql`
          INSERT INTO flows_runs (
            run_id, status, created_at_ms, state_json,
            owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms
          ) VALUES ('run-live', 'running', 2, '{}', 'host-a', 42, 'nonce-a', 3)
        `
        yield* database.sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES ('run-live', 0, 'evt', 'src', 0, 4, 'created', '1', 'null')
        `
        yield* database.sql`
          INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
          VALUES ('run-live', 'digest', 0, 'running', 5, '{}')
        `

        yield* Migrations.run
        // Re-running the completed ladder over the same rows stays a no-op.
        yield* Migrations.run

        const runs = yield* database.sql<{
          readonly run_id: string
          readonly state_json: string
          readonly parent_run_id: string | null
          readonly cancel_requested_at_ms: number | null
          readonly waiting_reason: string | null
          readonly waiting_wake_at_ms: number | null
          readonly waiting_token: string | null
        }>`SELECT * FROM flows_runs ORDER BY run_id`
        const events = yield* database.sql<{ readonly event_id: string }>`
          SELECT event_id FROM flows_journal_events
        `
        const attempts = yield* database.sql<{ readonly state: string }>`SELECT state FROM flows_attempts`
        const indexes = yield* database.sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'flows_runs_%'
        `
        // The new columns are writable over pre-existing rows.
        yield* database.sql`
          UPDATE flows_runs
          SET waiting_reason = 'quota', waiting_wake_at_ms = 9, parent_run_id = 'run-done'
          WHERE run_id = 'run-live'
        `
        const parked = yield* database.sql<{ readonly run_id: string }>`
          SELECT run_id FROM flows_runs WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <= 10
        `
        return { attempts, events, indexes: indexes.map((row) => row.name).sort(), parked, runs }
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(result.runs.map((row) => row.run_id)).toEqual(["run-done", "run-live"])
    expect(result.runs[0]?.state_json).toBe("{\"carried\":true}")
    for (const row of result.runs) {
      expect(row.parent_run_id).toBeNull()
      expect(row.cancel_requested_at_ms).toBeNull()
      expect(row.waiting_reason).toBeNull()
      expect(row.waiting_wake_at_ms).toBeNull()
      expect(row.waiting_token).toBeNull()
    }
    expect(result.events.map((row) => row.event_id)).toEqual(["evt"])
    expect(result.attempts.map((row) => row.state)).toEqual(["running"])
    expect(result.indexes).toEqual([
      "flows_runs_cancel_requested_idx",
      "flows_runs_parent_run_id_idx",
      "flows_runs_waiting_reason_wake_at_idx"
    ])
    expect(result.parked.map((row) => row.run_id)).toEqual(["run-live"])
  })

  it("stops the ladder at the requested migration", async () => {
    const columns = await run(
      Effect.gen(function*() {
        const database = yield* Database.Database
        yield* Migrations.runThrough("0002_durable_engine_state")
        const info = yield* database.sql<TableInfoRow>`PRAGMA table_info(flows_runs)`
        const applied = yield* database.sql<{ readonly name: string }>`
          SELECT name FROM flows_migrations ORDER BY migration_id
        `
        return { applied: applied.map((row) => row.name), columns: info.map((row) => row.name) }
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    // The migrator records names with their ordinal prefix stripped.
    expect(columns.applied).toEqual(["initial", "durable_engine_state"])
    expect(columns.columns).not.toContain("parent_run_id")
    expect(columns.columns).not.toContain("waiting_reason")
  })

  it("creates the expected schema without interpreter columns", async () => {
    const schema = await migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      const master = yield* database.sql<
        SqliteMasterRow
      >`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
      const tables = Object.fromEntries(
        yield* Effect.forEach(
          master.filter((row) => row.type === "table"),
          (row) =>
            Effect.map(
              database.sql<TableInfoRow>`PRAGMA table_info(${database.sql.literal(row.name)})`,
              (columns) => [row.name, columns.map((column) => column.name).sort()] as const
            )
        )
      )
      return { master, tables }
    }))

    expect(schema.master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
      "flows_attempts",
      "flows_clock_deadlines",
      "flows_deferred_completions",
      "flows_journal_events",
      "flows_migrations",
      "flows_runs",
      "flows_step_cache"
    ])
    expect(schema.master.some((row) => row.name === "flows_journal_events_event_type_idx" && row.type === "index"))
      .toBe(true)
    expect(schema.tables).toEqual({
      flows_attempts: [
        "attempt",
        "checkpoint_json",
        "error_json",
        "finished_at_ms",
        "heartbeat_at_ms",
        "meta_json",
        "outcome_json",
        "run_id",
        "started_at_ms",
        "state",
        "step_key_digest"
      ],
      flows_clock_deadlines: [
        "clock_name",
        "completed_at_ms",
        "deferred_name",
        "due_at_ms",
        "execution_id",
        "flow_name"
      ],
      flows_deferred_completions: [
        "completed_at_ms",
        "deferred_name",
        "execution_id",
        "exit_json",
        "flow_name",
        "metadata_json"
      ],
      flows_journal_events: [
        "emitted_at_ms",
        "event_id",
        "event_type",
        "meta_json",
        "payload_json",
        "run_id",
        "seq",
        "source_id",
        "source_seq"
      ],
      flows_migrations: ["created_at", "migration_id", "name"],
      flows_runs: [
        "cancel_requested_at_ms",
        "claim_host_id",
        "claim_nonce",
        "claim_pid",
        "claimed_at_ms",
        "created_at_ms",
        "finished_at_ms",
        "heartbeat_at_ms",
        "owner_host_id",
        "owner_nonce",
        "owner_pid",
        "parent_run_id",
        "run_id",
        "started_at_ms",
        "state_json",
        "status",
        "waiting_reason",
        "waiting_token",
        "waiting_wake_at_ms"
      ],
      flows_step_cache: [
        "created_at_ms",
        "key_digest",
        "meta_json",
        "recorded_event_seq",
        "recorded_run_id",
        "result_json"
      ]
    })
    expect(
      Object.values(schema.tables).flat().some((column) =>
        /agent|model|prompt|session|response|hijack|quota|resume/i.test(column)
      )
    ).toBe(false)
    const journalSql = schema.master.find((row) => row.name === "flows_journal_events")?.sql ?? ""
    const runsSql = schema.master.find((row) => row.name === "flows_runs")?.sql ?? ""
    const attemptsSql = schema.master.find((row) => row.name === "flows_attempts")?.sql ?? ""
    const cacheSql = schema.master.find((row) => row.name === "flows_step_cache")?.sql ?? ""
    const deferredsSql = schema.master.find((row) => row.name === "flows_deferred_completions")?.sql ?? ""
    const clocksSql = schema.master.find((row) => row.name === "flows_clock_deadlines")?.sql ?? ""
    expect(journalSql).toContain("PRIMARY KEY (run_id, seq)")
    expect(journalSql).toContain("UNIQUE (run_id, source_id, source_seq)")
    expect(runsSql).toContain("CHECK")
    expect(runsSql).toContain("status IN")
    expect(runsSql).toContain("status = 'running'")
    expect(runsSql).toContain("status <> 'running'")
    expect(runsSql).toContain("created_at_ms INTEGER NOT NULL")
    expect(attemptsSql).toContain("started_at_ms INTEGER NOT NULL")
    expect(attemptsSql).toContain("FOREIGN KEY (run_id) REFERENCES flows_runs (run_id)")
    expect(cacheSql).toContain("length(key_digest) > 0")
    expect(cacheSql).toContain("json_valid(result_json)")
    expect(cacheSql).toContain("json_valid(meta_json)")
    expect(cacheSql).toContain("typeof(created_at_ms) = 'integer'")
    expect(cacheSql).toContain("length(recorded_run_id) > 0")
    expect(cacheSql).toContain("typeof(recorded_event_seq) = 'integer'")
    expect(deferredsSql).toContain("completed_at_ms BIGINT NOT NULL")
    expect(deferredsSql).toContain("FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)")
    expect(clocksSql).toContain("due_at_ms BIGINT NOT NULL")
    expect(clocksSql).toContain("completed_at_ms BIGINT")
    expect(clocksSql).toContain("FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)")
    expect(`${deferredsSql}${clocksSql}`).not.toMatch(/json_valid|typeof/)
    expect(
      schema.master.some((row) => row.name === "flows_clock_deadlines_pending_idx" && row.type === "index")
    ).toBe(true)
  })

  it("rejects a half-populated owner tuple", async () => {
    await expect(migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      yield* database
        .sql`INSERT INTO flows_runs (run_id, status, owner_host_id, state_json) VALUES ('run', 'running', 'host', '{}')`
    }))).rejects.toBeDefined()
  })

  it("enforces every cache row invariant at the schema boundary", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      const invalidRows = [
        "('', '{}', '{}', 0, 'run', 0)",
        "('bad-result', 'not-json', '{}', 0, 'run', 0)",
        "('bad-meta', '{}', 'not-json', 0, 'run', 0)",
        "('negative-created', '{}', '{}', -1, 'run', 0)",
        "('fractional-created', '{}', '{}', 0.5, 'run', 0)",
        "('unsafe-created', '{}', '{}', 9007199254740992, 'run', 0)",
        "('empty-run', '{}', '{}', 0, '', 0)",
        "('negative-seq', '{}', '{}', 0, 'run', -1)",
        "('fractional-seq', '{}', '{}', 0, 'run', 0.5)",
        "('unsafe-seq', '{}', '{}', 0, 'run', 9007199254740992)"
      ] as const
      return yield* Effect.forEach(invalidRows, (values) =>
        Effect.exit(database.sql.unsafe(
          `INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ${values}`
        )))
    }))

    expect(outcomes.every(Exit.isFailure)).toBe(true)
  })
})
