import { Database } from "@smthrs/database/Database"
import * as DatabaseModule from "@smthrs/database/Database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/journal/Migrations"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import type * as TimeTravelStore from "../src/TimeTravelStore.ts"

const run = <A>(
  body: (
    store: TimeTravelStore.Service,
    sql: DatabaseModule.DatabaseService["sql"]
  ) => Effect.Effect<A, unknown, Database>
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Migrations.run
      const database = yield* Database
      const store = yield* SqlTimeTravelStore.make
      return yield* body(store, database.sql)
    }).pipe(Effect.provide(TestDatabase.layer)) as Effect.Effect<A, unknown>
  )

const insertRun = (
  sql: DatabaseModule.DatabaseService["sql"],
  runId: string,
  options: {
    readonly status?: string
    readonly stateJson?: string
    readonly claimHostId?: string | null
  } = {}
) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, claim_host_id, claim_pid, claim_nonce, claimed_at_ms)
    VALUES (
      ${runId},
      ${options.status ?? "suspended"},
      0,
      ${options.stateJson ?? JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
      NULL,
      ${options.claimHostId ?? null},
      ${options.claimHostId === undefined ? null : 4321},
      ${options.claimHostId === undefined ? null : "claim-nonce"},
      ${options.claimHostId === undefined ? null : 0}
    )
  `

/** The run table constrains ownership columns, so a live run must be inserted whole. */
const insertRunningRun = (sql: DatabaseModule.DatabaseService["sql"], runId: string) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
    VALUES (${runId}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
            'host-a', 1234, 'nonce', 0)
  `

describe("SqlTimeTravelStore.snapshotAt", () => {
  it("returns the newest snapshot at or before the frame, scoped to one lineage", async () => {
    const result = await run((store, sql) =>
      Effect.gen(function*() {
        for (
          const row of [
            { lineage: "main", seq: 0, changeId: "c0" },
            { lineage: "main", seq: 5, changeId: "c5" },
            { lineage: "other", seq: 7, changeId: "x7" }
          ]
        ) {
          yield* sql`
            INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id)
            VALUES ('run', ${row.lineage}, ${row.seq}, ${row.changeId})
          `
        }
        return {
          exact: yield* store.snapshotAt("run", { lineageId: "main", seq: 5 }),
          between: yield* store.snapshotAt("run", { lineageId: "main", seq: 4 }),
          beforeAny: yield* store.snapshotAt("run", { lineageId: "main", seq: -1 }),
          otherLineage: yield* store.snapshotAt("run", { lineageId: "other", seq: 100 }),
          otherRun: yield* store.snapshotAt("missing", { lineageId: "main", seq: 100 })
        }
      })
    )

    expect(result.exact).toEqual({ runId: "run", frame: { lineageId: "main", seq: 5 }, changeId: "c5" })
    expect(result.between).toEqual({ runId: "run", frame: { lineageId: "main", seq: 0 }, changeId: "c0" })
    expect(result.beforeAny).toBeUndefined()
    expect(result.otherLineage?.changeId).toBe("x7")
    expect(result.otherRun).toBeUndefined()
  })
})

describe("SqlTimeTravelStore.descendants", () => {
  it("walks attached descendants transitively and reports detached edges separately", async () => {
    const result = await run((store, sql) =>
      Effect.gen(function*() {
        const edges = [
          ["parent", 1, "before", "child", 1],
          ["parent", 3, "attached", "child", 1],
          ["attached", 0, "grandchild", "continuation", 1],
          ["parent", 4, "detached", "fork", 0]
        ] as const
        for (const [parentRunId, parentSeq, childRunId, kind, attached] of edges) {
          yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, ${parentSeq}, ${childRunId}, ${kind}, ${attached})
          `
        }
        return yield* store.descendants("parent", { lineageId: "main", seq: 2 })
      })
    )

    expect(result.attached.map((edge) => edge.childRunId)).toEqual(["attached", "grandchild"])
    expect(result.detached.map((edge) => edge.childRunId)).toEqual(["detached"])
    expect(result.attached[0]).toEqual({
      parentRunId: "parent",
      parentSeq: 3,
      childRunId: "attached",
      kind: "child",
      attached: true
    })
  })

  it("deduplicates an attached cycle while preserving every reachable edge", async () => {
    const result = await run((store, sql) =>
      Effect.gen(function*() {
        for (
          const [parentRunId, childRunId] of [
            ["parent", "child"],
            ["child", "parent"]
          ] as const
        ) {
          yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, 1, ${childRunId}, 'continuation', 1)
          `
        }
        return yield* store.descendants("parent", { lineageId: "main", seq: 0 })
      })
    )

    expect(result.attached.map((edge) => edge.childRunId)).toEqual(["child", "parent"])
    expect(result.detached).toEqual([])
  })
})

describe("SqlTimeTravelStore audits", () => {
  it("round-trips optional rate limit and detail payloads through pendingAudits", async () => {
    const result = await run((store) =>
      Effect.gen(function*() {
        yield* store.writeAudit({
          id: "audit-1",
          runId: "run",
          frame: { lineageId: "main", seq: 2 },
          status: "in_progress",
          rateLimit: { remaining: 3 },
          detail: { phase: "preflight" }
        })
        yield* store.writeAudit({
          id: "audit-2",
          runId: "run",
          frame: { lineageId: "main", seq: 9 },
          status: "completed"
        })
        return yield* store.pendingAudits()
      })
    )

    expect(result).toEqual([
      {
        id: "audit-1",
        runId: "run",
        frame: { lineageId: "main", seq: 2 },
        status: "in_progress",
        rateLimit: { remaining: 3 },
        detail: { phase: "preflight" }
      }
    ])
  })

  it("patches only the supplied fields and drops the audit out of the pending set", async () => {
    const result = await run((store) =>
      Effect.gen(function*() {
        yield* store.writeAudit({
          id: "audit",
          runId: "run",
          frame: { lineageId: "main", seq: 1 },
          status: "in_progress",
          rateLimit: { remaining: 1 }
        })
        yield* store.updateAudit("audit", { status: "failed" })
        const pending = yield* store.pendingAudits()
        yield* store.updateAudit("audit", { status: "in_progress", detail: { reason: "retry" } })
        const reopened = yield* store.pendingAudits()
        return { pending, reopened }
      })
    )

    expect(result.pending).toEqual([])
    expect(result.reopened).toEqual([
      {
        id: "audit",
        runId: "run",
        frame: { lineageId: "main", seq: 1 },
        status: "in_progress",
        rateLimit: { remaining: 1 },
        detail: { reason: "retry" }
      }
    ])
  })

  it("fails updateAudit for an unknown id", async () => {
    const error = await run((store) => Effect.flip(store.updateAudit("nope", { status: "completed" })))

    expect(error).toMatchObject({ code: "not_found", message: "audit nope was not found" })
  })

  it("keeps absent optional fields absent when an audit is updated", async () => {
    const [audit] = await run((store) =>
      Effect.gen(function*() {
        yield* store.writeAudit({
          id: "audit-empty",
          runId: "run",
          frame: { lineageId: "main", seq: 0 },
          status: "in_progress"
        })
        yield* store.updateAudit("audit-empty", { status: "in_progress" })
        return yield* store.pendingAudits()
      })
    )

    expect(audit).toEqual({
      id: "audit-empty",
      runId: "run",
      frame: { lineageId: "main", seq: 0 },
      status: "in_progress",
      rateLimit: undefined,
      detail: undefined
    })
  })

  it("returns a typed persistence failure for malformed persisted audit JSON", async () => {
    const failure = await run((store, sql) =>
      Effect.gen(function*() {
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`
          INSERT INTO flows_time_travel_audits
            (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json)
          VALUES ('malformed', 'run', 'main', 0, 'in_progress', NULL, '{')
        `
        return yield* Effect.flip(store.pendingAudits())
      })
    )

    expect(failure).toMatchObject({
      code: "unknown",
      message: "time-travel persistence failed",
      cause: expect.anything()
    })
  })

  it("rejects rows outside every durable time-travel boundary", async () => {
    const outcomes = await run((_store, sql) => {
      const invalidStatements = [
        `INSERT INTO flows_time_travel_audits VALUES ('', 'run', 'main', 0, 'in_progress', NULL, NULL)`,
        `INSERT INTO flows_time_travel_audits VALUES ('audit-negative', 'run', 'main', -1, 'in_progress', NULL, NULL)`,
        `INSERT INTO flows_time_travel_audits VALUES ('audit-fractional', 'run', 'main', 0.5, 'in_progress', NULL, NULL)`,
        `INSERT INTO flows_time_travel_audits VALUES ('audit-unsafe', 'run', 'main', 9007199254740992, 'in_progress', NULL, NULL)`,
        `INSERT INTO flows_time_travel_audits VALUES ('audit-status', 'run', 'main', 0, 'unknown', NULL, NULL)`,
        `INSERT INTO flows_time_travel_audits VALUES ('audit-json', 'run', 'main', 0, 'in_progress', '{', NULL)`,
        `INSERT INTO flows_time_travel_receipts VALUES ('', 'audit', 'effect', '{}')`,
        `INSERT INTO flows_time_travel_receipts VALUES ('receipt-audit', '', 'effect', '{}')`,
        `INSERT INTO flows_time_travel_receipts VALUES ('receipt-effect', 'audit', '', '{}')`,
        `INSERT INTO flows_time_travel_receipts VALUES ('receipt-json', 'audit', 'effect', '{')`,
        `INSERT INTO flows_time_travel_snapshots VALUES ('', 'main', 0, 'change')`,
        `INSERT INTO flows_time_travel_snapshots VALUES ('run', '', 0, 'change')`,
        `INSERT INTO flows_time_travel_snapshots VALUES ('run', 'main', -1, 'change')`,
        `INSERT INTO flows_time_travel_snapshots VALUES ('run', 'main', 0, '')`,
        `INSERT INTO flows_time_travel_edges VALUES ('', 0, 'child', 'child', 1)`,
        `INSERT INTO flows_time_travel_edges VALUES ('parent', -1, 'child', 'child', 1)`,
        `INSERT INTO flows_time_travel_edges VALUES ('parent', 0, '', 'child', 1)`,
        `INSERT INTO flows_time_travel_edges VALUES ('parent', 0, 'child-kind', 'unknown', 1)`,
        `INSERT INTO flows_time_travel_edges VALUES ('parent', 0, 'child-attached', 'child', 2)`,
        `INSERT INTO flows_time_travel_edges VALUES ('same', 0, 'same', 'child', 1)`,
        `INSERT INTO flows_time_travel_archive VALUES ('', 0, 'event', 'source', 0, 0, 'type', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', -1, 'event', 'source', 0, 0, 'type', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, '', 'source', 0, 0, 'type', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-source', '', 0, 0, 'type', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-seq', 'source', -1, 0, 'type', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-emitted', 'source', 0, -1, 'type', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-type', 'source', 0, 0, '', '{}', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-payload', 'source', 0, 0, 'type', '{', '{}', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-meta', 'source', 0, 0, 'type', '{}', '{', 0)`,
        `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-archived', 'source', 0, 0, 'type', '{}', '{}', -1)`
      ] as const
      return Effect.forEach(invalidStatements, (statement) => Effect.exit(sql.unsafe(statement)))
    })

    expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true)
  })
})

describe("SqlTimeTravelStore construction", () => {
  it("dies before exposing a store when its migration cannot run", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(SqlTimeTravelStore.make.pipe(Effect.provide(DatabaseModule.layerNoop)))
    )

    expect(exit._tag).toBe("Failure")
  })
})

describe("SqlTimeTravelStore persistence fault matrix", () => {
  const audit: TimeTravelStore.Audit = {
    id: "audit",
    runId: "run",
    frame: { lineageId: "main", seq: 0 },
    status: "in_progress"
  }

  for (
    const scenario of [
      {
        method: "snapshotAt",
        table: "flows_time_travel_snapshots",
        invoke: (store: TimeTravelStore.Service) => store.snapshotAt("run", audit.frame)
      },
      {
        method: "descendants",
        table: "flows_time_travel_edges",
        invoke: (store: TimeTravelStore.Service) => store.descendants("run", audit.frame)
      },
      {
        method: "writeAudit",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.writeAudit(audit)
      },
      {
        method: "updateAudit",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.updateAudit("audit", { status: "failed" })
      },
      {
        method: "pendingAudits",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.pendingAudits()
      },
      {
        method: "archiveAndTruncate",
        table: "flows_time_travel_edges",
        invoke: (store: TimeTravelStore.Service) => store.archiveAndTruncate("run", audit.frame, [])
      },
      {
        method: "createFork",
        table: "flows_runs",
        invoke: (store: TimeTravelStore.Service) => store.createFork("run", audit.frame)
      },
      {
        method: "recordReceipt",
        table: "flows_time_travel_receipts",
        invoke: (store: TimeTravelStore.Service) =>
          store.recordReceipt({ id: "receipt", auditId: "audit", effectId: "effect", receipt: {} })
      }
    ] as const
  ) {
    it(`maps a ${scenario.method} database failure to the store's typed error`, async () => {
      const failure = await run((store, sql) =>
        Effect.gen(function*() {
          yield* sql.unsafe(`DROP TABLE ${scenario.table}`)
          return yield* Effect.flip(scenario.invoke(store))
        })
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "time-travel persistence failed",
        cause: expect.anything()
      })
    })
  }

  it("rolls journal archival back when receipt persistence fails at commit", async () => {
    const result = await run((store, sql) =>
      Effect.gen(function*() {
        yield* insertRun(sql, "run")
        for (const seq of [0, 2]) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'source', ${seq}, 0, 'test', '{}', '{}')
          `
        }
        yield* store.recordReceipt({
          id: "duplicate",
          auditId: "audit",
          effectId: "existing",
          receipt: { existing: true }
        })

        const failure = yield* Effect.flip(
          store.archiveAndTruncate("run", { lineageId: "main", seq: 0 }, [{
            id: "duplicate",
            auditId: "audit",
            effectId: "new",
            receipt: { existing: false }
          }])
        )
        const journal = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = 'run' ORDER BY seq
        `
        const archive = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_time_travel_archive WHERE run_id = 'run' ORDER BY seq
        `
        const receipts = yield* sql<{ readonly id: string; readonly effect_id: string }>`
          SELECT id, effect_id FROM flows_time_travel_receipts ORDER BY id
        `
        return { failure, journal, archive, receipts }
      })
    )

    expect(result.failure).toMatchObject({ code: "unknown", message: "time-travel persistence failed" })
    expect(result.journal).toEqual([{ seq: 0 }, { seq: 2 }])
    expect(result.archive).toEqual([])
    expect(result.receipts).toEqual([{ id: "duplicate", effect_id: "existing" }])
  })
})

describe("SqlTimeTravelStore.recordReceipt", () => {
  it("persists a receipt row that archiveAndTruncate can then append to", async () => {
    const rows = await run((store, sql) =>
      Effect.gen(function*() {
        yield* store.recordReceipt({ id: "r1", auditId: "audit", effectId: "effect-a", receipt: { undone: true } })
        yield* insertRun(sql, "run")
        yield* store.archiveAndTruncate("run", { lineageId: "main", seq: 0 }, [
          { id: "r2", auditId: "audit", effectId: "effect-b", receipt: { undone: false } }
        ])
        return yield* sql<
          { readonly id: string; readonly effect_id: string; readonly receipt_json: string }
        >`SELECT id, effect_id, receipt_json FROM flows_time_travel_receipts ORDER BY id`
      })
    )

    expect(rows).toEqual([
      { id: "r1", effect_id: "effect-a", receipt_json: JSON.stringify({ undone: true }) },
      { id: "r2", effect_id: "effect-b", receipt_json: JSON.stringify({ undone: false }) }
    ])
  })
})

describe("SqlTimeTravelStore.createFork", () => {
  it("copies the prefix, attempts and restartable state, and numbers repeated forks", async () => {
    const result = await run((store, sql) =>
      Effect.gen(function*() {
        yield* insertRun(sql, "parent", {
          stateJson: JSON.stringify({
            version: 1,
            flowName: "Demo",
            payload: { seed: 1 },
            result: { _tag: "Success" },
            cancellation: { interruptedAtMs: 1 }
          })
        })
        for (const seq of [0, 1, 2]) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('parent', ${seq}, ${`e${seq}`}, 'source', ${seq}, 0, 'test', '{}', '{}')
          `
        }
        yield* sql`
          INSERT INTO flows_attempts
            (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
             heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json)
          VALUES ('parent', 'digest', 1, 'succeeded', 0, 1, 1, NULL, NULL, '{}', '{}')
        `

        const first = yield* store.createFork("parent", { lineageId: "main", seq: 1 })
        const second = yield* store.createFork("parent", { lineageId: "main", seq: 1 })
        const forkEvents = yield* sql<{ readonly seq: number; readonly event_id: string }>`
          SELECT seq, event_id FROM flows_journal_events WHERE run_id = ${first.runId} ORDER BY seq
        `
        const forkRun = yield* sql<{ readonly status: string; readonly state_json: string }>`
          SELECT status, state_json FROM flows_runs WHERE run_id = ${first.runId}
        `
        const forkAttempts = yield* sql<{ readonly step_key_digest: string }>`
          SELECT step_key_digest FROM flows_attempts WHERE run_id = ${first.runId}
        `
        return { first, second, forkEvents, forkRun, forkAttempts }
      })
    )

    expect(result.first.runId).toBe("parent:fork:1:1")
    expect(result.second.runId).toBe("parent:fork:1:2")
    expect(result.first.edge).toEqual({
      parentRunId: "parent",
      parentSeq: 1,
      childRunId: "parent:fork:1:1",
      kind: "fork",
      attached: false
    })
    expect(result.forkEvents.map((row) => row.seq)).toEqual([0, 1])
    expect(result.forkEvents[0]!.event_id).toBe("fork:parent:fork:1:1:e0")
    expect(result.forkRun[0]!.status).toBe("pending")
    expect(JSON.parse(result.forkRun[0]!.state_json)).toEqual({
      version: 1,
      flowName: "Demo",
      payload: { seed: 1 }
    })
    expect(result.forkAttempts).toEqual([{ step_key_digest: "digest" }])
  })

  it("surfaces a missing parent as a typed `not_found` failure", async () => {
    const error = await run((store) => Effect.flip(store.createFork("ghost", { lineageId: "main", seq: 0 })))

    expect(error).toMatchObject({ code: "not_found", message: "parent ghost was not found" })
  })

  for (
    const scenario of [
      { name: "is running and owned", running: true },
      { name: "is only claimed by another host", running: false }
    ] as const
  ) {
    it(`refuses to fork when the parent ${scenario.name}`, async () => {
      const error = await run((store, sql) =>
        Effect.gen(function*() {
          yield* scenario.running
            ? insertRunningRun(sql, "parent")
            : insertRun(sql, "parent", { claimHostId: "host-b" })
          return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
        })
      )

      expect(error).toMatchObject({ code: "live_parent", message: "parent parent is live" })
    })
  }

  it("refuses to fork when a transitive ancestor is live", async () => {
    const error = await run((store, sql) =>
      Effect.gen(function*() {
        yield* insertRunningRun(sql, "grandparent")
        yield* insertRun(sql, "parent")
        yield* sql`
          INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('grandparent', 0, 'parent', 'fork', 0)
        `
        return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
      })
    )

    expect(error).toMatchObject({ code: "live_parent", message: "parent grandparent is live" })
  })

  for (
    const [name, stateJson] of [
      ["malformed JSON", "{"],
      ["null", JSON.stringify(null)],
      ["an array", JSON.stringify([])],
      ["a missing version", JSON.stringify({ flowName: "Demo", payload: {} })],
      ["a newer version", JSON.stringify({ version: 2, flowName: "Demo", payload: {} })],
      ["a non-string flow name", JSON.stringify({ version: 1, flowName: 1, payload: {} })],
      ["a missing payload", JSON.stringify({ version: 1, flowName: "Demo" })]
    ] as const
  ) {
    it(`rejects ${name} as a restartable parent state`, async () => {
      const failure = await run((store, sql) =>
        Effect.gen(function*() {
          yield* sql`PRAGMA ignore_check_constraints = ON`
          yield* insertRun(sql, "parent", { stateJson })
          return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
        })
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not materialize executable fork state" })
    })
  }
})
