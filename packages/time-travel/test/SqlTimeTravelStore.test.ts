import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/journal/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

describe("SqlTimeTravelStore", () => {
  it("archives and truncates attached descendants in one database write", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Migrations.run
        const sql = yield* Effect.service(SqlClient.SqlClient)

        const store = yield* SqlTimeTravelStore.make
        for (const runId of ["parent", "child", "grandchild", "detached"]) {
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${runId}, 'suspended', 0, '{}')
          `
        }
        const journalRows = [
          { runId: "parent", seq: 0 },
          { runId: "parent", seq: 2 },
          { runId: "child", seq: 0 },
          { runId: "grandchild", seq: 0 },
          { runId: "detached", seq: 0 }
        ] as const
        for (const row of journalRows) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES (
              ${row.runId},
              ${row.seq},
              ${`${row.runId}-${row.seq}`},
              ${`source-${row.runId}`},
              ${row.seq},
              0,
              'test',
              '{}',
              '{}'
            )
          `
        }
        yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('parent', 2, 'child', 'child', 1)
        `
        yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('child', 0, 'grandchild', 'continuation', 1)
        `
        yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('parent', 2, 'detached', 'child', 0)
        `

        const archive = yield* store.archiveAndTruncate(
          "parent",
          { lineageId: "parent/root", seq: 0 },
          []
        )
        const remaining = yield* sql<{ readonly run_id: string; readonly seq: number }>`
          SELECT run_id, seq FROM flows_journal_events ORDER BY run_id, seq
        `
        const archived = yield* sql<{ readonly run_id: string; readonly seq: number }>`
          SELECT run_id, seq FROM flows_time_travel_archive ORDER BY run_id, seq
        `
        const edges = yield* sql<{ readonly child_run_id: string }>`
          SELECT child_run_id FROM flows_time_travel_edges ORDER BY child_run_id
        `
        return { archive, remaining, archived, edges }
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(result.archive.archived).toBe(3)
    expect(result.archive.orphaned.map((edge) => edge.childRunId)).toEqual(["detached"])
    expect(result.remaining).toEqual([
      { run_id: "detached", seq: 0 },
      { run_id: "parent", seq: 0 }
    ])
    expect(result.archived).toEqual([
      { run_id: "child", seq: 0 },
      { run_id: "grandchild", seq: 0 },
      { run_id: "parent", seq: 2 }
    ])
    expect(result.edges).toEqual([{ child_run_id: "detached" }])
  })
})
