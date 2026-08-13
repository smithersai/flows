/**
 * The workspace-side implementation of the sync read path.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal-next"
import type * as JournalEvent from "@smthrs/journal-next/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { type BranchId, branchOfRunId, type ShareCapability } from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
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
export class SyncServer extends Context.Service<SyncServer, Service>()("@smthrs/sync-next/SyncServer") {}

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
 * Branch runs are the authorization boundary: a run whose id maps to a shared
 * branch is visible only when the request's share capability verifies for that
 * branch. An explicitly scoped branch read without one fails; a workspace
 * listing simply excludes branch runs the caller cannot read, so one share
 * link never leaks another branch's log. Without a {@link BranchShare} in
 * scope every branch run is closed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const catalog = yield* RunCatalog.RunCatalog
  const share = yield* Effect.serviceOption(BranchShare.BranchShare)

  const covered = Effect.map(catalog.list, (ids) => [...ids].sort())

  /** A branch read is granted only by a capability that verifies for it. */
  const canReadBranch = (
    branchId: BranchId,
    capability: ShareCapability | undefined
  ): Effect.Effect<boolean> =>
    Option.isNone(share) || capability === undefined
      ? Effect.succeed(false)
      : share.value.verify(capability, { branchId, access: "read" }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )

  /** Whether one catalog-advertised run may be followed by this request. */
  const canFollow = (runId: JournalEvent.RunId, capability: ShareCapability | undefined): Effect.Effect<boolean> => {
    const branchId = branchOfRunId(runId)
    return branchId === null ? Effect.succeed(true) : canReadBranch(branchId, capability)
  }

  /**
   * The runs a request may observe. A run-scoped request for a branch the
   * capability does not cover fails the request outright — a scoped read must
   * never silently answer with an empty or partial view of someone else's
   * branch.
   */
  const runIdsFor = (
    scope: SyncProtocol.Scope,
    capability: ShareCapability | undefined
  ): Effect.Effect<ReadonlyArray<JournalEvent.RunId>, SyncError> =>
    scope._tag === "Run"
      ? Effect.gen(function*() {
        const branchId = branchOfRunId(scope.runId)
        if (branchId !== null && !(yield* canReadBranch(branchId, capability))) {
          return yield* Effect.fail(
            new SyncError({
              code: "unauthorized",
              message: "Reading a shared branch requires a valid share capability"
            })
          )
        }
        return [scope.runId]
      })
      : Effect.gen(function*() {
        const runIds = yield* covered
        const visible: Array<JournalEvent.RunId> = []
        for (const runId of runIds) {
          if (yield* canFollow(runId, capability)) visible.push(runId)
        }
        return visible
      })

  const read = (request: SyncProtocol.ReadRequest): Effect.Effect<SyncProtocol.ReadResponse, SyncError> =>
    Effect.gen(function*() {
      const runIds = yield* runIdsFor(request.scope, request.capability)
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
    Stream.unwrap(
      Effect.map(runIdsFor(request.scope, request.capability), (runIds) =>
        request.scope._tag === "Run"
          ? runStream(request.scope.runId, request.cursors)
          : Stream.merge(
            Stream.flatMap(
              Stream.fromIterable(runIds),
              (runId) => runStream(runId, request.cursors),
              { concurrency: "unbounded" }
            ),
            Stream.flatMap(
              Stream.filterEffect(catalog.changes, (runId) => canFollow(runId, request.capability)),
              (runId) => runStream(runId, request.cursors),
              { concurrency: "unbounded" }
            )
          ))
    ).pipe(Stream.take(request.credit))

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
