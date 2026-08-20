import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Exit, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Fold from "../src/Fold.ts"
import * as Migrations from "../src/Migrations.ts"
import initial from "../src/migrations/0001_initial.ts"
import lineage from "../src/migrations/0002_lineage.ts"
import * as RunStore from "../src/RunStore.ts"

const database = (filename: string) => Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))

const withDatabase = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient | DurableWriter.DurableWriter>
) => Effect.scoped(effect.pipe(Effect.provide(database(filename))))

const withJournalDatabase = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, Journal | SqlClient.SqlClient | DurableWriter.DurableWriter>
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(SqlJournal.layer({ capacity: 1024, overflow: "reject" })),
      Effect.provide(database(filename))
    )
  )

const initialSet: DatabaseMigrations.MigrationSet = {
  namespace: Migrations.set.namespace,
  idOffset: Migrations.set.idOffset,
  migrations: { "0001_initial": initial }
}

const preFoldSet: DatabaseMigrations.MigrationSet = {
  namespace: Migrations.set.namespace,
  idOffset: Migrations.set.idOffset,
  migrations: {
    "0001_initial": initial,
    "0002_lineage": lineage
  }
}

describe("run-store durable migration upgrade", () => {
  it.effect(
    "rolls back an interrupted 0002, then preserves old rows and enforces the upgraded constraints",
    () =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-run-store-migration-")))
        const filename = join(directory, "upgrade.sqlite")
        try {
          yield* withDatabase(
            filename,
            Effect.gen(function*() {
              yield* DatabaseMigrations.run([initialSet])
              const sql = yield* Effect.service(SqlClient.SqlClient)
              yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('legacy-run', 'pending', 7, '{"legacy":true}')
          `
              yield* sql`
            INSERT INTO flows_attempts (
              run_id, step_key_digest, attempt, state, started_at_ms, meta_json
            ) VALUES ('legacy-run', 'legacy-step', 0, 'running', 8, '{"legacy":true}')
          `
            })
          )

          const interruptedLineage = Effect.gen(function*() {
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
          ALTER TABLE flows_runs
          ADD COLUMN lineage_id TEXT CHECK (lineage_id IS NULL OR length(lineage_id) > 0)
        `
            return yield* Effect.interrupt
          })
          const interruptedSet: DatabaseMigrations.MigrationSet = {
            ...initialSet,
            migrations: {
              ...initialSet.migrations,
              "0002_lineage": interruptedLineage
            }
          }
          const interrupted = yield* Effect.exit(
            Effect.scoped(DatabaseMigrations.run([interruptedSet]).pipe(Effect.provide(database(filename))))
          )
          expect(Exit.isFailure(interrupted)).toBe(true)

          const beforeUpgrade = yield* withDatabase(
            filename,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(flows_runs)`.withoutTransform
              const applied = yield* sql<{ readonly migration_id: number }>`
            SELECT migration_id FROM flows_migrations ORDER BY migration_id
          `.withoutTransform
              return { applied, columns }
            })
          )
          expect(beforeUpgrade.columns.map((column) => column.name)).not.toContain("lineage_id")
          expect(beforeUpgrade.applied.map((row) => row.migration_id)).toEqual([1001])

          const applied = yield* withDatabase(
            filename,
            DatabaseMigrations.run([JournalMigrations.set, Migrations.set])
          )

          const upgraded = yield* withJournalDatabase(
            filename,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const runs = yield* RunStore.make
              const attempts = yield* AttemptStore.make
              const legacyRun = yield* runs.get("legacy-run")
              const legacyAttempt = Option.getOrThrow(
                yield* attempts.get({ runId: "legacy-run", stepKeyDigest: "legacy-step", attempt: 0 })
              )

              yield* runs.create("lineage-round-one", "{}", { lineageId: "durable-lineage", roundOrdinal: 1 })
              const duplicateLineage = yield* Effect.exit(
                runs.create("lineage-round-one-duplicate", "{}", {
                  lineageId: "durable-lineage",
                  roundOrdinal: 1
                })
              )
              const missingRunAttempt = yield* Effect.exit(sql`
            INSERT INTO flows_attempts (
              run_id, step_key_digest, attempt, state, started_at_ms, meta_json
            ) VALUES ('missing-run', 'orphan', 0, 'running', 9, '{}')
          `)
              const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(flows_runs)`.withoutTransform
              const indexes = yield* sql<{ readonly name: string; readonly unique: number }>`
            PRAGMA index_list(flows_runs)
          `.withoutTransform
              const foreignKeys = yield* sql<{
                readonly from: string
                readonly table: string
                readonly to: string
              }>`PRAGMA foreign_key_list(flows_attempts)`.withoutTransform
              const rejectedRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM flows_runs
            WHERE run_id = 'lineage-round-one-duplicate'
          `.withoutTransform
              const orphanRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM flows_attempts
            WHERE run_id = 'missing-run'
          `.withoutTransform
              return {
                applied,
                columns,
                duplicateLineage,
                foreignKeys,
                indexes,
                legacyAttempt,
                legacyRun,
                missingRunAttempt,
                orphanRows,
                rejectedRows
              }
            })
          )

          expect(upgraded.applied).toEqual([
            [1, "journal_initial"],
            [2, "journal_checkpoints"],
            [3, "journal_consensus"],
            [1002, "run-store_lineage"],
            [1003, "run-store_fold_snapshots"]
          ])
          expect(upgraded.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "lineage_id",
            "round_ordinal"
          ]))
          expect(upgraded.legacyRun).toMatchObject({
            runId: "legacy-run",
            stateJson: "{\"legacy\":true}",
            lineageId: null,
            roundOrdinal: null
          })
          expect(upgraded.legacyAttempt).toMatchObject({
            runId: "legacy-run",
            stepKeyDigest: "legacy-step",
            meta: { legacy: true }
          })
          expect(Exit.isFailure(upgraded.duplicateLineage)).toBe(true)
          expect(upgraded.indexes).toContainEqual(expect.objectContaining({
            name: "flows_runs_lineage_idx",
            unique: 1
          }))
          expect(upgraded.rejectedRows).toEqual([{ count: 0 }])
          expect(Exit.isFailure(upgraded.missingRunAttempt)).toBe(true)
          expect(upgraded.foreignKeys).toContainEqual(expect.objectContaining({
            table: "flows_runs",
            from: "run_id",
            to: "run_id"
          }))
          expect(upgraded.orphanRows).toEqual([{ count: 0 }])
        } finally {
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        }
      }),
    120_000
  )

  it.effect(
    "backfills pre-fold rows into snapshot events that rebuild the materialization",
    () =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-run-store-fold-")))
        const filename = join(directory, "fold.sqlite")
        try {
          yield* withDatabase(
            filename,
            Effect.gen(function*() {
              yield* DatabaseMigrations.run([JournalMigrations.set, preFoldSet])
              const sql = yield* Effect.service(SqlClient.SqlClient)
              yield* sql`
            INSERT INTO flows_runs (
              run_id, status, created_at_ms, started_at_ms, owner_host_id, owner_pid, owner_nonce,
              heartbeat_at_ms, cancel_requested_at_ms, waiting_reason, waiting_wake_at_ms,
              waiting_token, state_json, lineage_id, round_ordinal
            ) VALUES (
              'legacy-fold-run', 'running', 7, 8, 'legacy-host', 9, 'legacy-owner',
              10, 11, 'timer', 12, 'wake-token', '{"legacy":true}', 'legacy-lineage', 0
            )
          `
              yield* sql`
            INSERT INTO flows_attempts (
              run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
              heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
            ) VALUES (
              'legacy-fold-run', 'legacy-step', 0, 'completed', 13, 14,
              15, '{"cursor":1}', '{"message":"old"}', '{"ok":true}', '{"legacy":true}'
            )
          `
            })
          )

          const rebuilt = yield* withJournalDatabase(
            filename,
            Effect.gen(function*() {
              const applied = yield* DatabaseMigrations.run([JournalMigrations.set, Migrations.set])
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const events = yield* sql<{ readonly eventType: string }>`
            SELECT event_type AS "eventType"
            FROM flows_journal_events
            WHERE run_id = 'legacy-fold-run'
            ORDER BY seq
          `
              yield* Fold.rebuild
              const run = yield* RunStore.make.pipe(Effect.flatMap((store) => store.get("legacy-fold-run")))
              const attempt = Option.getOrThrow(
                yield* AttemptStore.make.pipe(Effect.flatMap((store) =>
                  store.get({ runId: "legacy-fold-run", stepKeyDigest: "legacy-step", attempt: 0 })
                ))
              )
              return { applied, attempt, events, run }
            })
          )

          expect(rebuilt.applied).toEqual([[1003, "run-store_fold_snapshots"]])
          expect(rebuilt.events.map((row) =>
            row.eventType
          )).toEqual([
            "flows.run.snapshot",
            "flows.attempt.snapshot"
          ])
          expect(rebuilt.run).toMatchObject({
            runId: "legacy-fold-run",
            status: "running",
            owner: { hostId: "legacy-host", pid: 9, nonce: "legacy-owner" },
            heartbeatAtMs: 10,
            cancelRequestedAtMs: 11,
            lineageId: "legacy-lineage",
            roundOrdinal: 0,
            stateJson: "{\"legacy\":true}"
          })
          expect(rebuilt.attempt).toMatchObject({
            state: "completed",
            finishedAtMs: 14,
            checkpoint: { cursor: 1 },
            error: { message: "old" },
            outcome: { ok: true },
            meta: { legacy: true }
          })
          expect(rebuilt.attempt.heartbeatAtMs).toBeUndefined()
        } finally {
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        }
      }),
    120_000
  )
})
