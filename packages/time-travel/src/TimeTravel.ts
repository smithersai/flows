/**
 * The one door into time travel: inspect, fork, rewind.
 *
 * `Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and the
 * effect-handler registry are machinery under `src/internal/`; a caller never
 * names them. This service fronts the three verbs of
 * `docs/specs/Concepts/Time Travel.md` and owns the wiring they used to make
 * the caller thread: the ownership claim a rewind rides, the jj workspace a
 * fork lands in, the compensation-handler registry, and startup recovery of an
 * interrupted rewind.
 *
 * Recovery is not an operation. {@link layer} finishes or rolls back every
 * pending rewind audit while it is being built, so the service only ever hands
 * out a store whose interrupted work is already resolved.
 *
 * The tag key `@smthrs/time-travel/TimeTravel` is durable identity: step keys
 * digest the resolved service set, so renaming it invalidates recorded runs.
 *
 * @since 0.1.0
 */
import { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { Frame } from "./Frame.ts"
import * as EffectHandlerRegistry from "./internal/EffectHandlerRegistry.ts"
import * as ForkOperation from "./internal/Fork.ts"
import * as Recovery from "./internal/Recovery.ts"
import * as Replay from "./internal/Replay.ts"
import * as Rewind from "./internal/Rewind.ts"
import type { TimeTravelError } from "./TimeTravelError.ts"
import { type Fork as ForkRecord, TimeTravelStore } from "./TimeTravelStore.ts"

/**
 * Where in history an operation acts: a run, and a frame inside it.
 *
 * A frame is only an address — the `(lineageId, seq)` journal position — never
 * a snapshot. Every operation derives state by replaying the prefix.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Position = Schema.Struct({
  runId: Schema.NonEmptyString,
  frame: Frame
})
/** @since 0.1.0 @category models */
export type Position = typeof Position.Type

/**
 * A pure fold over durable journal evidence, handed to {@link Service.inspect}.
 *
 * @since 0.1.0
 * @category models
 */
export type Projection<S> = Replay.Projection<S>

/**
 * The successful shape of {@link Service.fork}: the child run and its lineage
 * edge back to the parent frame.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkResult = ForkRecord

/**
 * The successful shape of {@link Service.rewind}: the audit row, the archived
 * suffix, and everything the boundary disclosed.
 *
 * @since 0.1.0
 * @category models
 */
export type RewindResult = Rewind.Result

/**
 * How a fork chooses its workspace.
 *
 * The workspace name and path are derived from the position by default;
 * `workspaceRoot` only moves where the derived lane lands.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
  readonly workspaceRoot?: string | undefined
}

/**
 * How a rewind treats what it crosses.
 *
 * `detachedChildren` defaults to `"block"`: a live detached child refuses the
 * rewind rather than being cancelled behind the operator's back.
 *
 * @since 0.1.0
 * @category models
 */
export interface RewindOptions {
  readonly detachedChildren?: "block" | "cancel" | undefined
  readonly pageSize?: number | undefined
}

/**
 * Inspect, fork, and rewind over a journal.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly inspect: <S>(
    position: Position,
    projection: Projection<S>
  ) => Effect.Effect<S, TimeTravelError>
  readonly fork: (
    position: Position,
    options?: ForkOptions
  ) => Effect.Effect<ForkResult, TimeTravelError>
  readonly rewind: (
    position: Position,
    options?: RewindOptions
  ) => Effect.Effect<RewindResult, TimeTravelError>
}

/**
 * The injectable contracts the three operations read and write through.
 *
 * The store is the only time-travel-specific one; the rest are the journal,
 * run, cache, and jj services the engine already provides.
 */
type Requirements =
  | CacheStore.CacheStore
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | TimeTravelStore

/** The default lane a derived fork workspace lands in. */
const workspaceRoot = ".flows/forks"

const workspaceSlug = (position: Position): string =>
  `flows-fork-${`${position.runId}-${position.frame.seq}`.replace(/[^A-Za-z0-9._-]/g, "-")}`

/**
 * Mints the ownership identity every rewind and every recovery rides.
 *
 * Browser-safe on purpose: `Clock` and `Random` are services, so this never
 * reaches for `process.pid` or `node:crypto` the way an engine incarnation
 * does.
 */
const mintOwner: Effect.Effect<OwnerId> = Effect.gen(function*() {
  const nowMs = yield* Clock.currentTimeMillis
  const entropy = yield* Random.nextIntBetween(0, 0x7fffffff)
  return { hostId: "time-travel", pid: 0, nonce: `time-travel:${nowMs}:${entropy}` }
})

/**
 * Builds the service over the ambient contracts, recovering first.
 *
 * The scope this is built in owns every fork workspace the service adds: a
 * fork lane is forgotten when the service is released, not when the call that
 * created it returns.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, TimeTravelError, Requirements | Scope.Scope> = Effect.gen(function*() {
  const scope = yield* Effect.scope
  const services = yield* Effect.context<Requirements>()
  const owner = yield* mintOwner
  const registry = EffectHandlerRegistry.makeNoop()

  const provided = <A>(
    effect: Effect.Effect<A, TimeTravelError, Requirements | EffectHandlerRegistry.EffectHandlerRegistry | Scope.Scope>
  ): Effect.Effect<A, TimeTravelError> =>
    effect.pipe(
      Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
      Effect.provideService(Scope.Scope, scope),
      Effect.provideContext(services)
    )

  // Recovery is wiring, never an operation: a rewind interrupted by a crash is
  // finished or rolled back before this service accepts new work.
  yield* provided(Recovery.recover({ owner }))

  return {
    inspect: (position, projection) =>
      provided(
        Replay.rederive(position.frame, projection, { runId: position.runId })
      ),
    fork: (position, options) =>
      provided(
        ForkOperation.fork({
          parentRunId: position.runId,
          frame: position.frame,
          workspaceName: workspaceSlug(position),
          workspacePath: `${options?.workspaceRoot ?? workspaceRoot}/${workspaceSlug(position)}`
        })
      ),
    rewind: (position, options) =>
      provided(
        Rewind.rewind({
          runId: position.runId,
          frame: position.frame,
          owner,
          detachedChildPolicy: options?.detachedChildren ?? "block",
          ...(options?.pageSize === undefined ? {} : { pageSize: options.pageSize })
        })
      )
  }
})

/**
 * The one injectable time-travel surface.
 *
 * ```ts
 * import { TimeTravel } from "@smthrs/flows"
 * import * as Effect from "effect/Effect"
 *
 * const program = Effect.gen(function*() {
 *   const timeTravel = yield* TimeTravel
 *   return yield* timeTravel.rewind({ runId: "ledger-1", frame: { lineageId: "ledger-1/root", seq: 2 } })
 * })
 * ```
 *
 * @since 0.1.0
 * @category services
 */
export class TimeTravel extends Context.Service<TimeTravel, Service>()(
  "@smthrs/time-travel/TimeTravel"
) {
  /**
   * Wires the machinery over the injectable contracts and recovers on build.
   *
   * Carried as a static so the umbrella barrel can export the service key
   * itself — `yield* Flows.TimeTravel` — without losing the way to provide it.
   *
   * @since 0.1.0
   * @category layers
   */
  static readonly layer: Layer.Layer<TimeTravel, TimeTravelError, Requirements> = Layer.effect(TimeTravel)(make)
}

/**
 * Wires the machinery over the injectable contracts and recovers on build.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<TimeTravel, TimeTravelError, Requirements> = TimeTravel.layer
