import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Frame, LineageEdge } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
/** @since 0.1.0 @category models */
export const Snapshot = Schema.Struct({ runId: Schema.NonEmptyString, frame: Frame, changeId: Schema.NonEmptyString })
/** @since 0.1.0 @category models */
export type Snapshot = typeof Snapshot.Type
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
/** @since 0.1.0 @category models */
export const Fork = Schema.Struct({ runId: Schema.NonEmptyString, edge: LineageEdge })
/** @since 0.1.0 @category models */
export type Fork = typeof Fork.Type
/** @since 0.1.0 @category services */
export interface Service {
  readonly snapshotAt: (runId: string, frame: Frame) => Effect.Effect<Snapshot | undefined, TimeTravelError>
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
