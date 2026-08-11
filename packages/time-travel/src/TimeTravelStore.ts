import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Frame, LineageEdge } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
/**
 * The tier-2 anchor recorded at a frame: the jj pointer current when that seq
 * was journaled, and the plan digest in force.
 *
 * `docs/specs/Concepts/Time Travel.md` names exactly these two as the things
 * replay cannot derive and the frame must therefore carry. `planDigest` is
 * optional because a run driven without a persisted plan has none — an absent
 * digest means "no plan was in force", never "the digest was lost".
 *
 * @since 0.1.0 @category models
 */
export const Snapshot = Schema.Struct({
  runId: Schema.NonEmptyString,
  frame: Frame,
  changeId: Schema.NonEmptyString,
  planDigest: Schema.optionalKey(Schema.NonEmptyString)
})
/** @since 0.1.0 @category models */
export type Snapshot = typeof Snapshot.Type
/**
 * The attempt rows that existed at a frame, addressed the way
 * `flows_attempts` addresses them.
 *
 * A fork copies exactly this set rather than every attempt the parent ever
 * ran: an attempt that started after the frame is not part of the history the
 * child inherits.
 *
 * @since 0.1.0 @category models
 */
export const AttemptRef = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
/** @since 0.1.0 @category models */
export type AttemptRef = typeof AttemptRef.Type
/** @since 0.1.0 @category models */
export const Descendants = Schema.Struct({ attached: Schema.Array(LineageEdge), detached: Schema.Array(LineageEdge) })
/** @since 0.1.0 @category models */
export type Descendants = typeof Descendants.Type
/** @since 0.1.0 @category models */
export const Audit = Schema.Struct({
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  frame: Frame,
  status: Schema.Literals(["in_progress", "completed", "failed"]),
  rateLimit: Schema.optionalKey(Schema.Unknown),
  detail: Schema.optionalKey(Schema.Unknown)
})
/** @since 0.1.0 @category models */
export type Audit = typeof Audit.Type
/** @since 0.1.0 @category models */
export const Receipt = Schema.Struct({
  id: Schema.NonEmptyString,
  auditId: Schema.NonEmptyString,
  effectId: Schema.NonEmptyString,
  receipt: Schema.Unknown
})
/** @since 0.1.0 @category models */
export type Receipt = typeof Receipt.Type
/** @since 0.1.0 @category models */
export const ArchiveResult = Schema.Struct({
  archived: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  orphaned: Schema.Array(LineageEdge)
})
/** @since 0.1.0 @category models */
export type ArchiveResult = typeof ArchiveResult.Type
/**
 * A fork's outcome: the child run, its lineage edge, and everything the
 * boundary assessment disclosed.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork: a fork never compensates, so the
 * assessment still runs and its blocking and revertible entries are
 * **normalized to warnings** — "this effect may execute again on the child".
 * A fork with a non-empty `warnings` is a successful fork, not a refused one.
 *
 * @since 0.1.0 @category models
 */
export const Fork = Schema.Struct({
  runId: Schema.NonEmptyString,
  edge: LineageEdge,
  warnings: Schema.Array(Schema.String)
})
/** @since 0.1.0 @category models */
export type Fork = typeof Fork.Type
/** @since 0.1.0 @category services */
export interface Service {
  readonly snapshotAt: (runId: string, frame: Frame) => Effect.Effect<Snapshot | undefined, TimeTravelError>
  /**
   * Records one tier-2 anchor. Written by the snapshot projector, which folds
   * the engine's `snapshot-identified` records; never by a caller.
   */
  readonly recordSnapshot: (snapshot: Snapshot) => Effect.Effect<void, TimeTravelError>
  /**
   * The run state AT a frame, derived by replaying the run-decision records up
   * to it — not read off the run row, whose `state_json` is the run's *latest*
   * state (`docs/specs/Concepts/Time Travel.md`; Temporal's
   * `ndc/state_rebuilder.go`). Returns the encoded JSON, so the caller decides
   * what schema to read it under.
   */
  readonly stateAt: (runId: string, frame: Frame) => Effect.Effect<string | undefined, TimeTravelError>
  /**
   * The attempts that had been admitted at a frame, derived the same way from
   * the attempt lifecycle records.
   */
  readonly attemptsAt: (runId: string, frame: Frame) => Effect.Effect<ReadonlyArray<AttemptRef>, TimeTravelError>
  readonly descendants: (runId: string, frame: Frame) => Effect.Effect<Descendants, TimeTravelError>
  readonly writeAudit: (audit: Audit) => Effect.Effect<void, TimeTravelError>
  readonly updateAudit: (id: string, patch: Partial<Audit>) => Effect.Effect<void, TimeTravelError>
  readonly pendingAudits: () => Effect.Effect<ReadonlyArray<Audit>, TimeTravelError>
  readonly archiveAndTruncate: (
    runId: string,
    frame: Frame,
    receipts: ReadonlyArray<Receipt>
  ) => Effect.Effect<ArchiveResult, TimeTravelError>
  readonly createFork: (parentRunId: string, frame: Frame) => Effect.Effect<Fork, TimeTravelError>
  readonly recordReceipt: (receipt: Receipt) => Effect.Effect<void, TimeTravelError>
}
/** @since 0.1.0 @category services */
export class TimeTravelStore extends Context.Service<TimeTravelStore, Service>()("flows/time-travel/TimeTravelStore") {}
/** @since 0.1.0 @category constructors */
export const make = (implementation: Service): Service => TimeTravelStore.of(implementation)
const unavailable = <A>(method: string): Effect.Effect<A, TimeTravelError> =>
  Effect.fail(error("unknown", `${method} is unavailable`))
/** @since 0.1.0 @category constructors */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  TimeTravelStore.of({
    snapshotAt: () => unavailable("snapshotAt"),
    recordSnapshot: () => unavailable("recordSnapshot"),
    stateAt: () => unavailable("stateAt"),
    attemptsAt: () => unavailable("attemptsAt"),
    descendants: () => unavailable("descendants"),
    writeAudit: () => unavailable("writeAudit"),
    updateAudit: () => unavailable("updateAudit"),
    pendingAudits: () => unavailable("pendingAudits"),
    archiveAndTruncate: () => unavailable("archiveAndTruncate"),
    createFork: () => unavailable("createFork"),
    recordReceipt: () => unavailable("recordReceipt"),
    ...overrides
  })
/** @since 0.1.0 @category layers */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<TimeTravelStore> =>
  Layer.succeed(TimeTravelStore)(makeNoop(overrides))
