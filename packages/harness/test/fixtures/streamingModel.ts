import { Model, ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { Cause, Effect, Layer, Queue, Stream } from "effect"

/** @category fixtures @since 0.1.0 */
export interface ToolProgress {
  readonly callId: string
  readonly message: string
}

/** @category fixtures @since 0.1.0 */
export interface Step {
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  readonly progress: ReadonlyArray<ToolProgress>
}

/** @category fixtures @since 0.1.0 */
export interface Recorder {
  readonly requests: Array<ModelRequest.ModelRequest>
  readonly events: Array<ModelEvent.ModelEvent>
  readonly progress: Array<ToolProgress>
  transportComplete: boolean
}

/** @category fixtures @since 0.1.0 */
export interface Fixture {
  readonly model: Model.Model
  readonly layer: Layer.Layer<Model.Model>
  readonly recorder: Recorder
}

/** @category fixtures @since 0.1.0 */
export const interleaved: Step = {
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "text-one" }),
    ModelEvent.ModelEvent.ThinkingStart({ type: "thinking-start", id: "thinking" }),
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "text-two" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text-one", text: "I will " }),
    ModelEvent.ModelEvent.ThinkingDelta({ type: "thinking-delta", id: "thinking", text: "consider " }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text-two", text: "Then record " }),
    ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "stream-call", name: "alpha" }),
    ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "stream-call", arguments: "{\"value\":" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text-one", text: "call alpha" }),
    ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "stream-call", arguments: "\"one\"}" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text-two", text: "the result" }),
    ModelEvent.ModelEvent.ThinkingEnd({ type: "thinking-end", id: "thinking" }),
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "stream-call" }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "text-one" }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "text-two" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" })
  ],
  progress: [{ callId: "stream-call", message: "started" }, { callId: "stream-call", message: "finished" }]
}

/** @category fixtures @since 0.1.0 */
export const final: Step = {
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "final" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "final", text: "done" }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "final" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ],
  progress: []
}

/** @category constructors @since 0.1.0 */
export const make = (script: ReadonlyArray<Step>): Fixture => {
  const recorder: Recorder = { requests: [], events: [], progress: [], transportComplete: false }
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
      return Stream.fromIterable(step.events).pipe(
        Stream.tap((event) => Effect.sync(() => recorder.events.push(event)))
      )
    }
  })
  return { model, layer: Model.layer(model), recorder }
}

/**
 * Constructs a fixture whose transport reader pushes into an unbounded queue
 * on its own fiber. Slow downstream event handling therefore cannot stall
 * provider reads.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeBuffered = (script: ReadonlyArray<Step>): Fixture => {
  const recorder: Recorder = { requests: [], events: [], progress: [], transportComplete: false }
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
      recorder.transportComplete = false
      return Stream.unwrap(
        Effect.gen(function*() {
          const queue = yield* Queue.unbounded<ModelEvent.ModelEvent, Cause.Done>()
          yield* Effect.gen(function*() {
            for (const event of step.events) {
              recorder.events.push(event)
              yield* Queue.offer(queue, event)
            }
            recorder.transportComplete = true
            yield* Queue.end(queue)
          }).pipe(Effect.forkScoped({ startImmediately: true }))
          return Stream.fromQueue(queue)
        })
      )
    }
  })
  return { model, layer: Model.layer(model), recorder }
}
