/**
 * The deferred/clock fold backfill: one administrative snapshot record per
 * surviving row, so a pre-fold database survives migrate, drop, and rebuild
 * with equivalent state.
 *
 * Rows written before the fold have records that are missing
 * (`completed_at_ms` on fired clocks, whole rows on databases older than the
 * engine records) or not self-contained (pre-fold deferred payloads, which
 * may also have passed through the write-path redactor). This migration
 * appends `flows.engine.deferred-snapshot` / `flows.engine.clock-snapshot`
 * records — ordinary entries with valid per-run sequence numbers — before
 * the fold contract takes effect. On a fresh database both tables are empty
 * and the backfill is a no-op.
 *
 * The migration is deliberately self-contained: it inlines the event-id
 * format and the run-root journal lineage (`<runId>/root`) instead of
 * importing them, because an applied migration must stay byte-stable even if
 * the live constructors move.
 *
 * Design: `docs/specs/Concepts/Deferred Clock Fold.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** The reserved producer of backfill snapshots; never used by a live writer. */
const migrationSource = "flows-fold-migration"

interface DeferredTableRow {
  readonly flowName: string
  readonly executionId: string
  readonly deferredName: string
  readonly exitJson: string
  readonly metadataJson: string | null
  readonly completedAtMs: number
}

interface ClockTableRow {
  readonly flowName: string
  readonly executionId: string
  readonly clockName: string
  readonly deferredName: string
  readonly dueAtMs: number
  readonly completedAtMs: number | null
}

/**
 * Appends one snapshot record per surviving deferred/clock row.
 *
 * @category migrations
 * @since 0.1.0
 */
const fold: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const deferreds = yield* sql<DeferredTableRow>`
    SELECT
      flow_name AS "flowName",
      execution_id AS "executionId",
      deferred_name AS "deferredName",
      exit_json AS "exitJson",
      metadata_json AS "metadataJson",
      completed_at_ms AS "completedAtMs"
    FROM flows_deferred_completions
    ORDER BY execution_id, flow_name, deferred_name
  `
  const clocks = yield* sql<ClockTableRow>`
    SELECT
      flow_name AS "flowName",
      execution_id AS "executionId",
      clock_name AS "clockName",
      deferred_name AS "deferredName",
      due_at_ms AS "dueAtMs",
      completed_at_ms AS "completedAtMs"
    FROM flows_clock_deadlines
    ORDER BY execution_id, flow_name, clock_name
  `
  if (deferreds.length === 0 && clocks.length === 0) {
    return
  }

  // Per-run sequence allocation: the base is read once per run, then
  // advanced locally, so the backfilled entries extend each run's committed
  // history without forking its sequence clock. The journal reads its own
  // allocation floor from MAX(seq) lazily, so it picks these up.
  const nextSeq = new Map<string, number>()
  const allocate = (runId: string) =>
    Effect.gen(function*() {
      const known = nextSeq.get(runId)
      if (known !== undefined) {
        nextSeq.set(runId, known + 1)
        return known
      }
      const rows = yield* sql<{ readonly next: number | null }>`
        SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${runId}
      `
      // MAX() over an empty history returns one NULL row: the run has no
      // entries yet and its sequence clock starts at zero.
      const base = Number(rows[0]!.next ?? 0)
      nextSeq.set(runId, base + 1)
      return base
    })

  const insert = (options: {
    readonly runId: string
    readonly sourceId: string
    readonly eventType: string
    readonly emittedAtMs: number
    readonly payload: Record<string, unknown>
  }) =>
    Effect.gen(function*() {
      const seq = yield* allocate(options.runId)
      // The `flows:event:<len>:<runId><len>:<sourceId><sourceSeq>` format of
      // `JournalEvent.makeEventId`, inlined; source_seq is 0 — one snapshot
      // per address per backfill source.
      const eventId = `flows:event:${options.runId.length}:${options.runId}${options.sourceId.length}:` +
        `${options.sourceId}0`
      yield* sql`
        INSERT INTO flows_journal_events (
          run_id,
          seq,
          event_id,
          source_id,
          source_seq,
          emitted_at_ms,
          event_type,
          payload_json,
          meta_json
        ) VALUES (
          ${options.runId},
          ${seq},
          ${eventId},
          ${options.sourceId},
          0,
          ${options.emittedAtMs},
          ${options.eventType},
          ${JSON.stringify(options.payload)},
          ${JSON.stringify({ lineageId: `${options.runId}/root` })}
        )
      `
    })

  for (const row of deferreds) {
    const key = JSON.stringify([row.flowName, row.executionId, row.deferredName])
    yield* insert({
      runId: row.executionId,
      sourceId: `${migrationSource}:deferred:${key}`,
      eventType: "flows.engine.deferred-snapshot",
      emittedAtMs: row.completedAtMs,
      payload: {
        flowName: row.flowName,
        executionId: row.executionId,
        deferredName: row.deferredName,
        exit: JSON.parse(row.exitJson),
        ...(row.metadataJson === null ? {} : { metadata: JSON.parse(row.metadataJson) }),
        completedAtMs: row.completedAtMs
      }
    })
  }
  for (const row of clocks) {
    const key = JSON.stringify([row.flowName, row.executionId, row.clockName])
    yield* insert({
      runId: row.executionId,
      sourceId: `${migrationSource}:clock:${key}`,
      eventType: "flows.engine.clock-snapshot",
      emittedAtMs: row.completedAtMs ?? row.dueAtMs,
      payload: {
        flowName: row.flowName,
        executionId: row.executionId,
        clockName: row.clockName,
        deferredName: row.deferredName,
        dueAtMs: row.dueAtMs,
        completedAtMs: row.completedAtMs
      }
    })
  }
})

export default fold
