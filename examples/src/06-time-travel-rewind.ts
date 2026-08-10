/**
 * Rewind a run to an earlier frame, and re-derive a view without executing.
 *
 * Two time-travel operations that need no engine at all:
 *
 * `Replay.rederive` folds committed journal entries up to a frame through a
 * pure reducer. It reads; it never invokes a flow handler or an activity.
 *
 * `Rewind.rewind` is the mutating protocol. It claims the run, records an
 * audit, assesses external effects recorded on the journal, restores the
 * workspace, and archives and truncates the suffix past the frame in one
 * transaction.
 *
 * A frame is `{ lineageId, seq }`, and `rederive` folds only entries whose
 * `meta.lineageId` matches, so every entry below carries one.
 */
import { Database } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Jj from "@smthrs/jj"
import { CacheStore, Journal, JournalEvent, Migrations, type Ownership, RunStore, SqlJournal } from "@smthrs/journal"
import { EffectHandlerRegistry, Replay, Rewind, SqlTimeTravelStore } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const owner: Ownership.OwnerId = { hostId: "rewind-host", pid: 1, nonce: "rewind-owner" }

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

const layer = (filename: string) =>
  Layer.mergeAll(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
        CacheStore.layer,
        RunStore.layer,
        SqlTimeTravelStore.layer
      ),
      Layer.provideMerge(Migrations.layer, NodeDatabase.layer({ filename }))
    ),
    hostJj,
    EffectHandlerRegistry.layerNoop
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

    yield* runs.create("ledger-1", JSON.stringify({ version: 1 }))
    const receipts = yield* Effect.forEach([10, 20, 30, 40], (amount, index) => journal.emitDurable(entry(index, amount)))
    const frameSeq = receipts[1]!.seq

    // Read-only: sum the credits recorded up to the frame.
    const derivedTotal = yield* Replay.rederive(
      { lineageId, seq: frameSeq },
      {
        initial: 0,
        reduce: (state: number, committed) => {
          const payload = committed.payload as { readonly amount?: number } | null
          return state + (payload?.amount ?? 0)
        }
      },
      { runId: "ledger-1" }
    )

    // Mutating: drop everything after the frame.
    const result = yield* Rewind.rewind({
      runId: "ledger-1",
      frame: { lineageId, seq: frameSeq },
      owner,
      auditId: "ledger-1-rewind"
    })

    const remaining = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 100 })
    const { sql } = yield* Database.Database
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
