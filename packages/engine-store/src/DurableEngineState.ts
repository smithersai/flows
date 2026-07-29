/**
 * Durable deferred-completion and clock-deadline state used by the workflow
 * engine adapter.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

/**
 * The durable address of a deferred result.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeferredAddress {
  readonly workflowName: string
  readonly executionId: string
  readonly deferredName: string
}

/**
 * The first durable completion recorded for a deferred.
 *
 * Correlation data remains opaque at this boundary. A future external-event
 * layer owns its schema and authorization policy.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeferredRow extends DeferredAddress {
  readonly exit: unknown
  readonly metadata?: unknown
  readonly completedAtMs: number
}

/**
 * Result of a first-writer-wins deferred completion.
 *
 * @since 0.1.0
 * @category models
 */
export type CompleteDeferredOutcome =
  | { readonly _tag: "Completed"; readonly row: DeferredRow }
  | { readonly _tag: "Existing"; readonly row: DeferredRow }

/**
 * The durable address of a clock.
 *
 * @since 0.1.0
 * @category models
 */
export interface ClockAddress {
  readonly workflowName: string
  readonly executionId: string
  readonly clockName: string
}

/**
 * A durable absolute clock deadline.
 *
 * @since 0.1.0
 * @category models
 */
export interface ClockRow extends ClockAddress {
  readonly deferredName: string
  readonly dueAtMs: number
  readonly completedAtMs: number | null
}

/**
 * Result of scheduling a durable clock.
 *
 * @since 0.1.0
 * @category models
 */
export type ScheduleClockOutcome =
  | { readonly _tag: "Scheduled"; readonly row: ClockRow }
  | { readonly _tag: "Existing"; readonly row: ClockRow }

/**
 * Result of completing a durable clock.
 *
 * @since 0.1.0
 * @category models
 */
export type CompleteClockOutcome =
  | { readonly _tag: "Completed"; readonly row: ClockRow }
  | { readonly _tag: "AlreadyCompleted"; readonly row: ClockRow }
  | { readonly _tag: "NotFound" }

/**
 * Minimal durable state missing from the current `@flows/journal` contract.
 *
 * A successful mutation means the row is durable. Callers may therefore
 * journal and schedule a wake only after the mutation returns.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  // TODO(piece-6): fold into @flows/journal — needs DeferredStore.get(workflowName, executionId, deferredName).
  readonly deferred: (address: DeferredAddress) => Effect.Effect<Option.Option<DeferredRow>>
  // TODO(piece-6): fold into @flows/journal — needs DeferredStore.completeFirstWriterWins(row).
  readonly completeDeferred: (row: DeferredRow) => Effect.Effect<CompleteDeferredOutcome>
  // TODO(piece-6): fold into @flows/journal — needs ClockStore.get(workflowName, executionId, clockName).
  readonly clock: (address: ClockAddress) => Effect.Effect<Option.Option<ClockRow>>
  // TODO(piece-6): fold into @flows/journal — needs ClockStore.scheduleFirstWriterWins(rowWithAbsoluteDueAtMs).
  readonly scheduleClock: (row: ClockRow) => Effect.Effect<ScheduleClockOutcome>
  // TODO(piece-6): fold into @flows/journal — needs ClockStore.completeOnce(address, completedAtMs).
  readonly completeClock: (
    address: ClockAddress,
    completedAtMs: number
  ) => Effect.Effect<CompleteClockOutcome>
  // TODO(piece-6): fold into @flows/journal — needs ClockStore.due(nowMs).
  readonly dueClocks: (nowMs: number) => Effect.Effect<ReadonlyArray<ClockRow>>
}

/**
 * Service tag for durable deferred completions and absolute clock deadlines.
 *
 * @since 0.1.0
 * @category services
 */
export class DurableEngineState extends Context.Service<DurableEngineState, Service>()(
  "flows/engine-store/DurableEngineState"
) {}

const deferredKey = (address: DeferredAddress): string =>
  JSON.stringify([address.workflowName, address.executionId, address.deferredName])

const clockKey = (address: ClockAddress): string =>
  JSON.stringify([address.workflowName, address.executionId, address.clockName])

/**
 * Constructs a deterministic in-memory durable-state implementation.
 *
 * The returned service can be shared by multiple fresh engine instances in a
 * test to model process restart over the same storage.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeMemory = (): Service => {
  const deferreds = new Map<string, DeferredRow>()
  const clocks = new Map<string, ClockRow>()

  return DurableEngineState.of({
    deferred: Effect.fn("DurableEngineState.deferred")((address) =>
      Effect.sync(() => Option.fromNullishOr(deferreds.get(deferredKey(address))))
    ),
    completeDeferred: Effect.fn("DurableEngineState.completeDeferred")((row) =>
      Effect.sync(() => {
        const key = deferredKey(row)
        const existing = deferreds.get(key)
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: existing }
        }
        deferreds.set(key, row)
        return { _tag: "Completed" as const, row }
      })
    ),
    clock: Effect.fn("DurableEngineState.clock")((address) =>
      Effect.sync(() => Option.fromNullishOr(clocks.get(clockKey(address))))
    ),
    scheduleClock: Effect.fn("DurableEngineState.scheduleClock")((row) =>
      Effect.sync(() => {
        const key = clockKey(row)
        const existing = clocks.get(key)
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: existing }
        }
        clocks.set(key, row)
        return { _tag: "Scheduled" as const, row }
      })
    ),
    completeClock: Effect.fn("DurableEngineState.completeClock")((address, completedAtMs) =>
      Effect.sync(() => {
        const key = clockKey(address)
        const existing = clocks.get(key)
        if (existing === undefined) {
          return { _tag: "NotFound" as const }
        }
        if (existing.completedAtMs !== null) {
          return { _tag: "AlreadyCompleted" as const, row: existing }
        }
        const row = { ...existing, completedAtMs }
        clocks.set(key, row)
        return { _tag: "Completed" as const, row }
      })
    ),
    dueClocks: Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
      Effect.sync(() =>
        Array.from(clocks.values())
          .filter((row) => row.completedAtMs === null && row.dueAtMs <= nowMs)
          .sort((left, right) =>
            left.dueAtMs - right.dueAtMs ||
            left.executionId.localeCompare(right.executionId) ||
            left.clockName.localeCompare(right.clockName)
          )
      )
    )
  })
}

/**
 * Provides deterministic in-memory durable engine state.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemory: Layer.Layer<DurableEngineState> = Layer.sync(
  DurableEngineState,
  makeMemory
)
