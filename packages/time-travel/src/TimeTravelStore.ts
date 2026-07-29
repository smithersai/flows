import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Frame, LineageEdge } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
/** @since 0.1.0 @category models */
export interface Snapshot {
  readonly runId: string
  readonly frame: Frame
  readonly changeId: string
}
/** @since 0.1.0 @category models */
export interface Descendants {
  readonly attached: ReadonlyArray<LineageEdge>
  readonly detached: ReadonlyArray<LineageEdge>
}
/** @since 0.1.0 @category models */
export interface Audit {
  readonly id: string
  readonly runId: string
  readonly frame: Frame
  readonly status: "in_progress" | "completed" | "failed"
  readonly rateLimit?: unknown
  readonly detail?: unknown
}
/** @since 0.1.0 @category models */
export interface Receipt {
  readonly id: string
  readonly auditId: string
  readonly effectId: string
  readonly receipt: unknown
}
/** @since 0.1.0 @category models */
export interface ArchiveResult {
  readonly archived: number
  readonly orphaned: ReadonlyArray<LineageEdge>
}
/** @since 0.1.0 @category models */
export interface Fork {
  readonly runId: string
  readonly edge: LineageEdge
}
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
