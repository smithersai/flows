// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The execution contract flow authoring APIs are written against.
 *
 * `FlowRuntime` is the port: the smallest service a `Flow`, an `Activity`, a
 * `DurableDeferred`, or a `DurableClock` needs in order to be executed,
 * polled, suspended, and resumed. `@smthrs/flow-next` declares it and depends on
 * nothing that implements it; `@smthrs/engine-next` supplies the implementation,
 * so the dependency runs one way only.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Activity from "../Activity/index.ts"
import type { DurableClock } from "../DurableClock.ts"
import type * as DurableDeferred from "../DurableDeferred.ts"
import type * as Flow from "../Flow/index.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { FlowCycleDetected } from "./FlowCycleDetected.ts"
import type { FlowInstance } from "./FlowInstance.ts"

/**
 * Service that represents a flow runtime, responsible for registering and
 * executing flows and coordinating activities, durable deferreds,
 * interrupts, resumes, and clocks.
 *
 * @category services
 * @since 4.0.0
 */
export class FlowRuntime extends Context.Service<
  FlowRuntime,
  {
    /**
     * Register a flow with the runtime.
     */
    readonly register: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      R
    >(
      flow: Flow.Flow<Name, Payload, Success, Error>,
      execute: (
        payload: Payload["Type"],
        executionId: string
      ) => Effect.Effect<Success["Type"], Error["Type"], R>
    ) => Effect.Effect<
      void,
      never,
      | Scope.Scope
      | Exclude<
        R,
        | FlowRuntime
        | FlowInstance
        | Flow.Execution<Name>
        | Scope.Scope
      >
      | Payload["DecodingServices"]
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Success["EncodingServices"]
      | Error["DecodingServices"]
      | Error["EncodingServices"]
    >

    /**
     * Execute a registered flow.
     */
    readonly execute: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      flow: Flow.Flow<Name, Payload, Success, Error>,
      options: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetryPolicy?:
          | RetryPolicy.RetryPolicy
          | undefined
      }
    ) => Effect.Effect<
      Discard extends true ? string : Success["Type"],
      Error["Type"] | FlowCycleDetected,
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Error["DecodingServices"]
    >

    /**
     * Poll the current status of a registered flow execution.
     */
    readonly poll: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top
    >(
      flow: Flow.Flow<Name, Payload, Success, Error>,
      executionId: string
    ) => Effect.Effect<
      Option.Option<Flow.Result<Success["Type"], Error["Type"]>>,
      never,
      Success["DecodingServices"] | Error["DecodingServices"]
    >

    /**
     * Requests cancellation of a registered execution while preserving normal
     * cleanup, compensation, and child-flow handling. This is not a pause, and
     * a later `resume` does not undo the cancellation request.
     */
    readonly interrupt: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Immediately cancels a registered execution, potentially ignoring
     * compensation finalizers and orphaning child flows. This unsafe operation
     * is intended for forced shutdown, not ordinary cancellation or pausing.
     */
    readonly interruptUnsafe: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Re-drives a registered execution that returned `Suspended`, allowing it
     * to replay durable history and continue after an awaited condition becomes
     * ready. It does not undo `interrupt` and is not a general unpause operation.
     */
    readonly resume: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Execute an activity from a flow.
     */
    readonly activityExecute: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(
      activity: Activity.Activity<Success, Error, R>,
      attempt: number
    ) => Effect.Effect<
      Flow.Result<Success["Type"], Error["Type"]>,
      never,
      | Success["DecodingServices"]
      | Error["DecodingServices"]
      | R
      | Crypto.Crypto
      | FlowInstance
    >

    /**
     * Try to retrieve the result of an DurableDeferred
     */
    readonly deferredResult: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>
    ) => Effect.Effect<
      Option.Option<Exit.Exit<Success["Type"], Error["Type"]>>,
      never,
      FlowInstance
    >

    /**
     * Set the result of a DurableDeferred, and then resume any waiting
     * flows.
     */
    readonly deferredDone: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>,
      options: {
        readonly flowName: string
        readonly executionId: string
        readonly deferredName: string
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
      }
    ) => Effect.Effect<
      void,
      never,
      Success["EncodingServices"] | Error["EncodingServices"]
    >

    /**
     * Schedule a wake up for a DurableClock
     */
    readonly scheduleClock: (
      flow: Flow.Any,
      options: {
        readonly executionId: string
        readonly clock: DurableClock
      }
    ) => Effect.Effect<void>
  }
>()("effect/flow/FlowEngine") {}
