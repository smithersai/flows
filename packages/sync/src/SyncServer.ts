/**
 * The workspace-side implementation of the sync read path.
 *
 * @since 0.1.0
 */
import { Journal } from "@flows/journal"
import type * as JournalEvent from "@flows/journal/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as RunCatalog from "./RunCatalog.ts"
import { SyncError } from "./SyncError.ts"
import type * as SyncProtocol from "./SyncProtocol.ts"

/**
 * Sync read-path operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly read: (request: SyncProtocol.ReadRequest) => Effect.Effect<SyncProtocol.ReadResponse, SyncError>
  readonly subscribe: (request: SyncProtocol.SubscribeRequest) => Stream.Stream<SyncProtocol.Frame, SyncError>
}

/**
 * The workspace sync server.
 *
 * @category services
 * @since 0.1.0
 */
export class SyncServer extends Context.Service<SyncServer, Service>()("@flows/sync/SyncServer") {}

/**
 * Constructs a sync server from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => SyncServer.of(implementation)

/**
 * Constructs a closed sync server stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    read: Effect.fn("SyncServer.read")(() => Effect.succeed({ entries: [], cursors: [], done: true })),
    subscribe: (): Stream.Stream<SyncProtocol.Frame, SyncError> =>
      Stream.succeed<SyncProtocol.Frame>({ _tag: "Closed", reason: "Sync server is unavailable" }),
    ...overrides
  })

/**
 * Provides a closed sync server stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<SyncServer> = Layer.succeed(SyncServer, makeNoop())

const journalFailure = (cause: unknown): SyncError =>
  new SyncError({
    code: "unknown",
    message: cause instanceof Error ? cause.message : "Journal read failed",
    cause
  })

const cursorOf = (
  cursors: SyncProtocol.WorkspaceCursor,
  runId: JournalEvent.RunId
): JournalEvent.Seq | undefined => cursors.find((cursor) => cursor.runId === runId)?.afterSeq

/**
 * Constructs the workspace sync server over a journal and a run catalog.
 *
 * Reads page one run at a time so a single large run cannot starve the rest of
 * the workspace, and `done` is reported only when every covered run has been
 * paged to its durable tail.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const catalog = yield* RunCatalog.RunCatalog

  const covered = (scope: SyncProtocol.Scope): Effect.Effect<ReadonlyArray<JournalEvent.RunId>> =>
    scope._tag === "Run"
      ? Effect.succeed([scope.runId])
      : Effect.map(catalog.list, (ids) => [...ids].sort())

  const read = (request: SyncProtocol.ReadRequest): Effect.Effect<SyncProtocol.ReadResponse, SyncError> =>
    Effect.gen(function*() {
      const runIds = yield* covered(request.scope)
      const entries: Array<JournalEvent.Entry> = []
      const cursors = new Map(request.cursors.map((cursor) => [cursor.runId, cursor.afterSeq]))
      let done = true
      for (const runId of runIds) {
        if (entries.length >= request.limit) {
          done = false
          break
        }
        const after = cursorOf(request.cursors, runId)
        const page = yield* journal.entries({
          runId,
          ...(after === undefined ? {} : { after }),
          limit: request.limit - entries.length
        }).pipe(Effect.mapError(journalFailure))
        entries.push(...page.entries)
        const last = page.entries.at(-1)
        if (last !== undefined) cursors.set(runId, last.seq)
        if (page.hasMore) done = false
      }
      return {
        entries,
        cursors: Array.from(cursors, ([runId, afterSeq]) => ({ runId, afterSeq })),
        done
      }
    })

  const runStream = (
    runId: JournalEvent.RunId,
    cursors: SyncProtocol.WorkspaceCursor
  ): Stream.Stream<SyncProtocol.Frame, SyncError> => {
    const after = cursorOf(cursors, runId)
    return journal.stream({ runId, ...(after === undefined ? {} : { afterSequence: after }) }).pipe(
      Stream.mapError(journalFailure),
      Stream.mapAccum(
        () => after === undefined ? -1 : after,
        (previous, entry) => [
          entry.seq,
          [
            {
              _tag: "Entries",
              runId,
              fromSeq: (previous + 1) as JournalEvent.Seq,
              toSeq: entry.seq,
              entries: [entry]
            } satisfies SyncProtocol.Frame
          ]
        ]
      )
    )
  }

  const subscribe = (request: SyncProtocol.SubscribeRequest): Stream.Stream<SyncProtocol.Frame, SyncError> =>
    (request.scope._tag === "Run"
      ? runStream(request.scope.runId, request.cursors)
      : Stream.unwrap(
        Effect.map(catalog.list, (ids) =>
          Stream.merge(
            Stream.flatMap(
              Stream.fromIterable([...ids].sort()),
              (runId) => runStream(runId, request.cursors),
              { concurrency: "unbounded" }
            ),
            Stream.flatMap(
              catalog.changes,
              (runId) => runStream(runId, request.cursors),
              { concurrency: "unbounded" }
            )
          ))
      )).pipe(Stream.take(request.credit))

  return make({ read, subscribe })
})

/**
 * Provides the workspace sync server.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<SyncServer, never, Journal.Journal | RunCatalog.RunCatalog> = Layer.effect(
  SyncServer,
  makeLive
)
