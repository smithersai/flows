// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Runtime helpers for flow completion, suspension, scopes, and rollback.
 *
 * @since 4.0.0
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Filter from "effect/Filter"
import { dual, identity } from "effect/Function"
import * as Scope from "effect/Scope"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import { CaptureDefects, SuspendOnFailure } from "./Annotations.ts"
import { Complete, isResult, type Result, Suspended } from "./Result.ts"

/**
 * Runs an effect as a flow execution and converts its outcome into a
 * `Result`, handling suspension, defect capture, interruption, and flow
 * scope finalization.
 *
 * @category results
 * @since 4.0.0
 * @slop
 */
export const intoResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  Result<A, E>,
  never,
  Exclude<R, Scope.Scope> | FlowInstance
> =>
  Effect.contextWith((context: Context.Context<FlowInstance>) => {
    const instance = Context.get(context, FlowInstance)
    const captureDefects = Context.get(instance.flow.annotations, CaptureDefects)
    const suspendOnFailure = Context.get(instance.flow.annotations, SuspendOnFailure)
    return effect.pipe(
      // so we can use external interruption to suspend the flow
      Effect.forkChild({ startImmediately: true }),
      Effect.flatMap((fiber) => Effect.onInterrupt(Fiber.join(fiber), () => Fiber.interrupt(fiber))),
      Effect.interruptible,
      suspendOnFailure
        ? Effect.catchCause((cause) => {
          instance.suspended = true
          if (!Cause.hasInterruptsOnly(cause)) {
            instance.cause = Cause.die(Cause.squash(cause))
          }
          return Effect.interrupt
        })
        : identity,
      Effect.scoped,
      Effect.matchCauseEffect({
        // A body that handed off produced no answer of its own, so the slot
        // the handoff was recorded in wins over the value the handler returned
        // (`docs/specs/Concepts/Trampoline Loops.md`).
        onSuccess: (value) =>
          Effect.succeed(
            instance.handoff ?? new Complete({ exit: Exit.succeed(value) })
          ),
        onFailure: (cause): Effect.Effect<Result<A, E>> => {
          const [reasons, interrupts] = Arr.partition(
            cause.reasons,
            Filter.fromPredicate(Cause.isInterruptReason)
          )
          const hasInterruptsOnly = interrupts.length === cause.reasons.length
          const filtered = reasons.length === 0 ? cause : Cause.fromReasons(reasons)
          return instance.suspended && hasInterruptsOnly
            ? Effect.succeed(new Suspended({ cause: instance.cause }))
            : (!instance.interrupted && hasInterruptsOnly) ||
                (!captureDefects && Cause.hasDies(cause))
            ? Effect.failCause(filtered as Cause.Cause<never>)
            : Effect.succeed(new Complete({ exit: Exit.failCause(filtered) }))
        }
      }),
      (eff) =>
        Effect.onExitPrimitive(eff, (exit) => {
          if (Exit.isFailure(exit)) {
            return Scope.close(instance.scope, exit)
          } else if (exit.value._tag === "Complete") {
            return Scope.close(instance.scope, exit.value.exit)
          } else if (exit.value._tag === "Handoff") {
            // A handoff ends this round for good — the next round is a separate
            // execution with its own instance and its own scope — so the round's
            // scope closes here exactly as a completion closes it. A suspension
            // is the only settlement that keeps the scope open.
            return Scope.close(instance.scope, Exit.void)
          }
          return Effect.void
        }, true),
      Effect.uninterruptible
    )
  })

/**
 * Wraps an action-like effect so flow suspension waits for currently
 * running actions to finish or suspend.
 *
 * @category results
 * @since 4.0.0
 * @slop
 */
export const wrapActionResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  isSuspend: (value: A) => boolean
): Effect.Effect<A, E, R | FlowInstance> =>
  Effect.contextWith((context: Context.Context<FlowInstance>) => {
    const instance = Context.get(context, FlowInstance)
    const state = instance.actionState
    if (state.count === 0) state.latch.closeUnsafe()
    state.count++
    return Effect.onExit(effect, (exit) => {
      state.count--
      const isSuspended = Exit.isSuccess(exit) && isSuspend(exit.value)
      if (
        Exit.isSuccess(exit) &&
        isResult(exit.value) &&
        exit.value._tag === "Suspended" &&
        exit.value.cause
      ) {
        instance.cause = instance.cause
          ? Cause.combine(instance.cause, exit.value.cause)
          : exit.value.cause
      }
      return state.count === 0
        ? state.latch.open
        : isSuspended
        ? waitForZero(instance)
        : Effect.void
    })
  })

// Untraced because this latch loop is a flow scheduler hot path.
const waitForZero = Effect.fnUntraced(function*(instance: FlowInstance["Service"]) {
  const state = instance.actionState
  while (true) {
    if (state.count > 0) {
      yield* state.latch.await
      yield* Effect.yieldNow
      continue
    }
    yield* Effect.yieldNow
    if (state.count === 0) return
  }
})

/**
 * Accesses the flow scope, which is only closed when the flow execution fully completes.
 *
 * @category resource management
 * @since 4.0.0
 * @slop
 */
export const scope: Effect.Effect<
  Scope.Scope,
  never,
  FlowInstance
> = Effect.map(
  FlowInstance,
  (instance) => instance.scope as Scope.Scope
)

/**
 * Provides the flow scope to the given effect, and closes the scope only when the flow execution fully completes.
 *
 * @category resource management
 * @since 4.0.0
 * @slop
 */
export const provideScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | FlowInstance> =>
  Effect.flatMap(scope, (scope) => Scope.provide(effect, scope))

/**
 * Adds an exit finalizer to the current flow scope, preserving the
 * services available when the finalizer is registered.
 *
 * @category resource management
 * @since 4.0.0
 * @slop
 */
export const addFinalizer: <R>(
  f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
) => Effect.Effect<
  void,
  never,
  FlowInstance | R
> =
  // Untraced because suspension recursively re-enters flow execution.
  Effect.fnUntraced(function*<R>(
    f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
  ) {
    const instance = yield* FlowInstance
    const services = yield* Effect.context<R>()
    yield* Scope.addFinalizerExit(instance.scope, (exit) => Effect.provideContext(f(exit), services))
  })

/**
 * Runs an effect and registers how to undo its successful result if the
 * enclosing flow later exits unsuccessfully.
 *
 * **When to use**
 *
 * Use when a top-level flow operation changes something that must be undone if
 * a later operation causes the flow to fail or be interrupted.
 *
 * **Details**
 *
 * The effect runs first. If it fails, no rollback is registered. If it
 * succeeds, its value is captured in a flow-scope finalizer. The finalizer does
 * nothing when the enclosing flow succeeds; when the flow exits unsuccessfully
 * it calls `rollback(value, cause)`.
 *
 * **Gotchas**
 *
 * This applies only to effects run directly inside the flow execution. It does
 * not attach rollback behavior to nested actions. The rollback's typed error
 * channel is `never`; handle expected rollback failures inside the callback.
 *
 * @category resource management
 * @since 4.0.0
 * @slop
 */
export const withRollback: {
  <A, R2>(
    rollback: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): <E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope>
  <A, E, R, R2>(
    effect: Effect.Effect<A, E, R>,
    rollback: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope>
} = dual(2, <A, E, R, R2>(
  effect: Effect.Effect<A, E, R>,
  rollback: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
): Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.tap(
      restore(effect),
      (value) => addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : rollback(value, exit.cause))
    )
  ))

/**
 * Marks a flow instance as suspended and interrupts the current fiber to
 * stop execution until it is resumed.
 *
 * @category results
 * @since 4.0.0
 * @slop
 */
export const suspend = (instance: FlowInstance["Service"]): Effect.Effect<never> =>
  Effect.interruptible(Effect.callback<never>(() => {
    instance.suspended = true
    const fiber = Fiber.getCurrent()!
    fiber.interruptUnsafe(fiber.id)
  }))
