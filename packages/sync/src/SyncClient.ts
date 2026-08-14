/**
 * Browser-safe client for replaying and following journal entries.
 *
 * @since 0.1.0
 */
import type * as JournalEvent from "@smthrs/journal-next/JournalEvent"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import type { ShareCapability } from "./BranchProtocol.ts"
import { SyncError, SyncGapError } from "./SyncError.ts"
import type { EntriesFrame, Scope, WorkspaceCursor } from "./SyncProtocol.ts"
import { SyncRpcs } from "./SyncRpcs.ts"

/**
 * Input accepted by a sync subscription.
 *
 * `capability` authorizes branch reads: following a shared branch's run
 * requires a capability that verifies for that branch on the server.
 *
 * @category models
 * @since 0.1.0
 */
export interface SubscribeOptions {
  readonly scope: Scope
  readonly cursors: WorkspaceCursor
  readonly capability?: ShareCapability
}

/**
 * Replicated journal subscription operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly subscribe: (options: SubscribeOptions) => Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError>
  readonly cursors: Effect.Effect<WorkspaceCursor>
}

/**
 * The browser-safe journal replication client.
 *
 * @category services
 * @since 0.1.0
 */
export class Sync extends Context.Service<Sync, Service>()("@smthrs/sync-next/Sync") {}

/**
 * Constructs a closed sync stub, optionally overriding individual operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  Sync.of({
    subscribe: () => Stream.fail(new SyncError({ code: "closed", message: "Sync client is closed" })),
    cursors: Effect.succeed([]),
    ...overrides
  })

/**
 * Provides a closed sync stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Sync> =>
  Layer.succeed(Sync, makeNoop(overrides))

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof SyncRpcs>, RpcClientError.RpcClientError>

const transportError = (cause: unknown): SyncError =>
  cause instanceof SyncError
    ? cause
    : new SyncError({
      code: "transport_failed",
      message: cause instanceof Error ? cause.message : "Sync RPC transport failed",
      cause
    })

type Cursors = Map<JournalEvent.RunId, JournalEvent.Seq>

const cursorMap = (cursors: WorkspaceCursor): Cursors =>
  new Map(cursors.map((cursor) => [cursor.runId, cursor.afterSeq]))

const canonicalCursors = (cursors: ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>): WorkspaceCursor =>
  Array.from(cursors, ([runId, afterSeq]) => ({ runId, afterSeq })).sort((left, right) =>
    // A Map has one value per key, so this comparator never receives equal
    // run IDs. `cursorMap` and the acknowledged cursor state both establish
    // that invariant before reaching this boundary.
    left.runId > right.runId ? 1 : -1
  )

/**
 * Advances the shared acknowledged view monotonically. A lagging subscription
 * commits what it just consumed, but it must never move the shared cursor
 * backward past another subscription's progress.
 */
const advance = (
  cursors: ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>,
  runId: JournalEvent.RunId,
  throughSeq: JournalEvent.Seq
): ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq> => {
  const current = cursors.get(runId)
  if (current !== undefined && current >= throughSeq) return cursors
  const next = new Map(cursors)
  next.set(runId, throughSeq)
  return next
}

/**
 * Live-follow reconnect policy: exponential backoff capped at five seconds,
 * the same shape as `RpcClient`'s own transport retry policy, and only for
 * transport failures — gaps, authorization refusals, and server closes
 * propagate to the consumer.
 */
const reconnectPolicy = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced(5000)
]).pipe(
  Schedule.while(({ input }) => SyncError.is(input) && input.code === "transport_failed")
)

const isTransportCause = (cause: Cause.Cause<SyncError | SyncGapError>): boolean =>
  cause.reasons.filter(Cause.isFailReason).some((reason) =>
    SyncError.is(reason.error) && reason.error.code === "transport_failed"
  )

/**
 * Projects a Sync RPC client into the local replication service.
 *
 * The acknowledged cursors are per-service state in a `Ref`: concurrent
 * subscriptions share the view, and each commit only ever advances it. A
 * cursor advances in the same stream pull that admits each entry to the
 * consumer. Interrupted partial pages therefore retain the last admitted
 * entry rather than incorrectly acknowledging the server's whole page.
 *
 * A live follow that loses its transport reconnects under
 * {@link reconnectPolicy}, resuming from the acknowledged cursors; the failure
 * cause is logged before the retry folds it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = ({ client }: { readonly client: Client }): Effect.Effect<Service> =>
  Effect.sync(() => {
    const acknowledged = Ref.makeUnsafe<ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>>(new Map())

    const cursors = Effect.map(Ref.get(acknowledged), canonicalCursors)

    const subscribe = (options: SubscribeOptions): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
      Stream.unwrap(Effect.gen(function*() {
        const cursor = cursorMap(options.cursors)
        for (const [runId, afterSeq] of yield* Ref.get(acknowledged)) cursor.set(runId, afterSeq)

        const snapshot = (): WorkspaceCursor => canonicalCursors(cursor)

        const commit = (runId: JournalEvent.RunId, throughSeq: JournalEvent.Seq) =>
          Effect.sync(() => {
            cursor.set(runId, throughSeq)
          }).pipe(
            Effect.andThen(Ref.update(acknowledged, (shared) => advance(shared, runId, throughSeq)))
          )

        const batch = (frame: EntriesFrame): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> => {
          const afterSeq: number = cursor.get(frame.runId) ?? -1
          // `fromSeq` is the start of the server-declared covered interval. It is
          // intentionally compared to the cursor, not to the first entry's seq:
          // dropped journal admissions legitimately leave holes inside that range.
          if (frame.fromSeq > afterSeq + 1) {
            return Stream.fail(
              new SyncGapError({
                runId: frame.runId,
                expectedFrom: (afterSeq + 1) as JournalEvent.Seq,
                receivedFrom: frame.fromSeq
              })
            )
          }
          if (frame.toSeq <= afterSeq) return Stream.empty

          const entries = frame.entries.filter((entry) => entry.seq > afterSeq)
          return Stream.flatMap(
            Stream.fromIterable(entries),
            (entry) =>
              Stream.concat(
                Stream.drain(Stream.fromEffect(commit(frame.runId, entry.seq))),
                Stream.succeed(entry)
              )
          )
        }

        const livePage = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.unwrap(
            Effect.sync(() =>
              client["Sync.Subscribe"]({
                scope: options.scope,
                cursors: snapshot(),
                credit: 1,
                ...(options.capability === undefined ? {} : { capability: options.capability })
              })
            )
          ).pipe(
            Stream.mapError(transportError),
            Stream.flatMap((frame) => {
              switch (frame._tag) {
                case "Entries":
                  return batch(frame)
                case "Closed":
                  return Stream.fail(new SyncError({ code: "closed", message: "Sync subscription closed" }))
                default:
                  return Stream.empty
              }
            })
          )

        const live = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.concat(
            livePage(),
            Stream.unwrap(Effect.sync(live))
          )

        // The retry re-runs the whole follow from the acknowledged cursors,
        // and its schedule resets once entries flow again, so a long-lived
        // subscription pays the backoff only across consecutive failures.
        const follow = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          live().pipe(
            Stream.tapCause((cause) =>
              isTransportCause(cause)
                ? Effect.logWarning("sync live follow transport failed; reconnecting with backoff", cause)
                : Effect.void
            ),
            Stream.retry(reconnectPolicy)
          )

        const bootstrap = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.unwrap(
            client["Sync.Read"]({
              scope: options.scope,
              cursors: snapshot(),
              limit: 256,
              ...(options.capability === undefined ? {} : { capability: options.capability })
            }).pipe(
              Effect.mapError(transportError),
              Effect.map((response) => {
                const page = Stream.flatMap(
                  Stream.fromIterable(response.entries),
                  (entry) =>
                    Stream.concat(
                      Stream.drain(Stream.fromEffect(commit(entry.runId, entry.seq))),
                      Stream.succeed(entry)
                    )
                )
                return response.done ? Stream.concat(page, follow()) : Stream.concat(page, bootstrap())
              })
            )
          )

        return bootstrap()
      }))

    return Sync.of({ subscribe, cursors })
  })

/**
 * Provides a Sync client from the active RPC protocol.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Sync, never, RpcClient.Protocol> = Layer.effect(
  Sync,
  Effect.flatMap(RpcClient.make(SyncRpcs), (client) => make({ client }))
)
