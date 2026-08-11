/**
 * Rewind a run to an earlier frame, and re-derive a view without executing.
 *
 * Both operations hang off one injectable service:
 *
 * `inspect` folds committed journal entries up to a frame through a pure
 * reducer. It reads; it never invokes a flow handler or an activity.
 *
 * `rewind` is the mutating protocol. Behind the one call it claims the run,
 * records an audit, assesses external effects recorded on the journal, restores
 * the workspace, and archives and truncates the suffix past the frame in one
 * transaction. The ownership claim, the audit id, and the compensation-handler
 * registry are wired inside the service — none of them appear here.
 *
 * A position is a run id plus a frame `{ lineageId, seq }`, and `inspect` folds
 * only entries whose `meta.lineageId` matches, so every entry below carries one.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Jj from "@smthrs/jj"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { CacheStore } from "@smthrs/step-cache"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const lineageId = "ledger-1/root"

const hostJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "examples-rewind" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * `TimeTravel.layer` needs the store plus the journal, run, cache, and jj
 * services — the injectable contracts and nothing else. There is no handler
 * registry to provide and no recovery pass to schedule: building the layer
 * resolves any rewind a crash left half-finished.
 */
const layer = (filename: string) =>
  Layer.provideMerge(
    TimeTravel.layer,
    Layer.mergeAll(
      Layer.provideMerge(
        Layer.mergeAll(
          SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
          CacheStore.layer,
          RunStore.layer,
          SqlTimeTravelStore.layer
        ),
        Layer.provideMerge(
          Migrations.layer,
          Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
        )
      ),
      hostJj
    )
  )

export interface Summary {
  readonly derivedTotal: number
  readonly archivedCount: number
  readonly remainingSeqs: ReadonlyArray<number>
  readonly auditStatus: string
}

const entry = (sourceSeq: number, amount: number) =>
  new JournalEvent.Input({
    runId: "ledger-1" as JournalEvent.RunId,
    sourceId: "examples" as JournalEvent.SourceId,
    sourceSeq: sourceSeq as JournalEvent.SourceSeq,
    eventType: "examples.ledger.credited",
    payload: { amount },
    meta: { lineageId }
  })

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const runs = yield* RunStore.RunStore
    const timeTravel = yield* TimeTravel

    yield* runs.create("ledger-1", JSON.stringify({ version: 1 }))
    const receipts = yield* Effect.forEach([10, 20, 30, 40], (amount, index) => journal.emitDurable(entry(index, amount)))
    const position = { runId: "ledger-1", frame: { lineageId, seq: receipts[1]!.seq } }

    // Read-only: sum the credits recorded up to the frame.
    const derivedTotal = yield* timeTravel.inspect(position, {
      initial: 0,
      reduce: (state: number, committed) => {
        const payload = committed.payload as { readonly amount?: number } | null
        return state + (payload?.amount ?? 0)
      }
    })

    // Mutating: drop everything after the frame.
    const result = yield* timeTravel.rewind(position)

    const remaining = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 100 })
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const audits = yield* sql<{ readonly status: string }>`
      SELECT status FROM flows_time_travel_audits WHERE id = ${result.auditId}
    `

    return {
      derivedTotal,
      archivedCount: result.archive.archived,
      remainingSeqs: remaining.entries.map((committed) => committed.seq),
      auditStatus: audits[0]?.status ?? "missing"
    }
  }).pipe(
    Effect.provide(layer(filename)),
    Effect.scoped,
    Effect.orDie
  )
