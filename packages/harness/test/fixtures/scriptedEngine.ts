import { Permission } from "@smthrs/kernel"
import { Model } from "@smthrs/model"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import * as Cell from "../../src/Cell.ts"
import * as EngineLike from "../../src/EngineLike.ts"
import { HarnessError } from "../../src/HarnessError.ts"
import * as Plan from "../../src/Plan.ts"

/**
 * One scripted response to `EngineLike.splice`.
 *
 * @category fixtures
 * @since 0.1.0
 */
export type SpliceStep =
  | {
    readonly _tag: "Results"
    readonly results: ReadonlyArray<Plan.ChildResult>
  }
  | {
    readonly _tag: "PermissionRequired"
    readonly request: Permission.PermissionRequired
  }
  | {
    readonly _tag: "Interrupt"
    readonly startedChildren?: number | undefined
  }

/**
 * One scripted response to `EngineLike.call`.
 *
 * @category fixtures
 * @since 0.1.0
 */
export type CallStep =
  | {
    readonly _tag: "Success"
    readonly value: Schema.Json
    /**
     * The workspace this call leaves behind, when it changes one.
     *
     * Stated separately from the call's declared effects on purpose: this is
     * how a shell command behaves. It writes a tracked file, its input names
     * no write set, and the only way anything finds out is by measuring the
     * tree afterwards.
     */
    readonly tree?: string | undefined
  }
  | { readonly _tag: "Failure"; readonly message: string }
  | { readonly _tag: "PermissionRequired"; readonly request: Permission.PermissionRequired }
  | { readonly _tag: "Interrupt" }

/**
 * Calls observed at the engine boundary.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Recorder {
  readonly sealStep: Array<EngineLike.SealedModelStep>
  readonly splice: Array<Plan.Batch>
  readonly calls: Array<Cell.Call>
  readonly records: Array<EngineLike.RecordBoundary<unknown>>
  readonly suspend: Array<EngineLike.SuspendReason>
  readonly startedCallIds: Array<string>
  readonly abortedCallIds: Array<string>
}

/**
 * A scripted engine together with its layer and recorder.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Fixture {
  readonly engine: EngineLike.EngineLike
  readonly layer: Layer.Layer<EngineLike.EngineLike>
  readonly recorder: Recorder
  /**
   * The workspace the engine measures, as one string.
   *
   * `undefined` is a host that cannot measure its tree at all, which is what
   * an engine constructed without an initial tree reports — so every case
   * written before observation existed keeps the declared-writes basis.
   */
  readonly workspace: { value: string | undefined }
}

/**
 * Constructs an engine recorder. Sealed model steps delegate to the supplied
 * network-free model; child execution remains wholly behind `splice`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  model: Model.Model,
  spliceScript: ReadonlyArray<SpliceStep> = [],
  callScript: ReadonlyArray<CallStep> = [],
  tree?: string
): Fixture => {
  const workspace: { value: string | undefined } = { value: tree }
  const recorder: Recorder = {
    sealStep: [],
    splice: [],
    calls: [],
    records: [],
    suspend: [],
    startedCallIds: [],
    abortedCallIds: []
  }
  let spliceIndex = 0
  let callIndex = 0
  const engine = EngineLike.make({
    sealStep: (step) => {
      recorder.sealStep.push(step)
      return model.stream(step.request)
    },
    splice: (batch) => {
      recorder.splice.push(batch)
      const step = spliceScript[spliceIndex++] ?? {
        _tag: "Results",
        results: []
      }
      switch (step._tag) {
        case "Results":
          recorder.startedCallIds.push(...batch.children.map((child) => child.callId))
          return Stream.fromIterable(
            step.results.map((result) => new Plan.ChildSettled({ result }))
          )
        case "PermissionRequired":
          return Stream.fail(
            new HarnessError({
              code: "engine_failed",
              message: "Permission required",
              cause: step.request
            })
          )
        case "Interrupt": {
          const started = batch.children.slice(0, step.startedChildren ?? 1)
          recorder.startedCallIds.push(...started.map((child) => child.callId))
          return Stream.fromEffect(
            Effect.interrupt.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  recorder.abortedCallIds.push(...started.map((child) => child.callId))
                })
              )
            )
          )
        }
      }
    },
    call: (request) => {
      recorder.calls.push(request)
      const step = callScript[callIndex++] ?? { _tag: "Success", value: null }
      switch (step._tag) {
        case "Success":
          if (step.tree !== undefined) workspace.value = step.tree
          return Effect.succeed(new Cell.CallResult({ outcome: "success", value: step.value }))
        case "Failure":
          return Effect.succeed(
            new Cell.CallResult({ outcome: "failure", value: null, message: step.message })
          )
        case "PermissionRequired":
          return Effect.fail(
            new HarnessError({
              code: "engine_failed",
              message: "Permission required",
              cause: step.request
            })
          )
        case "Interrupt":
          return Effect.interrupt
      }
    },
    // The fixture keeps no journal: single-pass tests execute the boundary,
    // and replay behaviour is proven against the real engine in
    // `@smthrs/agent`.
    record: (boundary) => {
      recorder.records.push(boundary)
      return boundary.execute
    },
    observe: Effect.suspend(() =>
      Effect.succeed(
        workspace.value === undefined
          ? Option.none()
          : Option.some(new EngineLike.Observation({ digest: workspace.value, paths: 1 }))
      )
    ),
    suspend: (reason) => {
      recorder.suspend.push(reason)
      return Effect.fail(
        new HarnessError({
          code: "suspended",
          message: reason.message,
          cause: reason
        })
      )
    }
  })
  return {
    engine,
    layer: EngineLike.layer(engine),
    recorder,
    workspace
  }
}
