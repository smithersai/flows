import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const seed = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'suspended', 0, ${
      JSON.stringify({ version: 1, flowName: "Lineage", payload: {}, result: { _tag: "Success" } })
    })
    `
    yield* sql`
      INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
         event_type, payload_json, meta_json)
      VALUES (${runId}, 0, ${`${runId}-0`}, 'source', 0, 0, 'test', '{}', '{}')
    `
  })

describe("fork lineage", () => {
  it("records parent_run_id so ancestry is walkable in SQL", async () => {
    const ancestry = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Migrations.run
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* SqlTimeTravelStore.make
        yield* seed("root")
        const child = yield* store.createFork("root", { lineageId: "root/root", seq: 0 })
        const grandchild = yield* store.createFork(child.runId, { lineageId: "root/root", seq: 0 })
        const rows = yield* sql<{ readonly run_id: string }>`
          WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
            SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = ${grandchild.runId}
            UNION ALL
            SELECT flows_runs.run_id, flows_runs.parent_run_id
            FROM flows_runs JOIN ancestry ON flows_runs.run_id = ancestry.parent_run_id
          )
          SELECT run_id FROM ancestry
        `
        return { rows: rows.map((row) => row.run_id), child: child.runId, grandchild: grandchild.runId }
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
    )

    expect(ancestry.rows).toEqual([ancestry.grandchild, ancestry.child, "root"])
  })

  it("exposes the lineage edge on the decoded run row", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Migrations.run
        const store = yield* SqlTimeTravelStore.make
        const runs = yield* RunStore.make
        yield* seed("root")
        const child = yield* store.createFork("root", { lineageId: "root/root", seq: 0 })
        return yield* runs.get(child.runId)
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
    )

    expect(row.parentRunId).toBe("root")
    expect(row.status).toBe("pending")
  })
})
