import { Model, ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Layer, Stream } from "effect"

/** @category fixtures @since 0.1.0 */
export interface Step {
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  readonly interruptAfterEvents?: boolean | undefined
}

/** @category fixtures @since 0.1.0 */
export interface Recorder {
  readonly requests: Array<ModelRequest.ModelRequest>
  readonly events: Array<ModelEvent.ModelEvent>
}

/** @category fixtures @since 0.1.0 */
export interface Fixture {
  readonly model: Model.Model
  readonly layer: Layer.Layer<Model.Model>
  readonly recorder: Recorder
}

/** @category fixtures @since 0.1.0 */
export const multiToolBatch: Step = {
  events: [
    ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "abort-a", name: "alpha" }),
    ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "abort-a", arguments: "{\"value\":\"one\"}" }),
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "abort-a" }),
    ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "abort-b", name: "beta" }),
    ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "abort-b", arguments: "{\"value\":\"two\"}" }),
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "abort-b" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" })
  ]
}

/** @category fixtures @since 0.1.0 */
export const midStreamAbort: Step = {
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "abort-text" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "abort-text", text: "partial" })
  ],
  interruptAfterEvents: true
}

/** @category constructors @since 0.1.0 */
export const make = (script: ReadonlyArray<Step>): Fixture => {
  const recorder: Recorder = { requests: [], events: [] }
  let index = 0
  const model = Model.make({
    stream: (request) => {
      recorder.requests.push(request)
      const step = script[index++]
      if (step === undefined) {
        return Stream.fail(
          new ModelError.ModelError({
            code: "invalid_provider_output",
            message: `Unscripted model request at index ${index - 1}`
          })
        )
      }
      const events = Stream.fromIterable(step.events).pipe(
        Stream.tap((event) => Effect.sync(() => recorder.events.push(event)))
      )
      return step.interruptAfterEvents === true
        ? Stream.concat(events, Stream.fromEffect(Effect.interrupt))
        : events
    }
  })
  return { model, layer: Model.layer(model), recorder }
}
