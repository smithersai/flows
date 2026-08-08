/**
 * The transport-neutral flow execution contract.
 *
 * `FlowProxy` projects flows onto Effect RPC groups and HTTP APIs. This module
 * is the third projection, for runtimes where neither stack is practical — a
 * browser Service Worker answering `postMessage`, an edge worker's `fetch`
 * handler, a sandbox guest reading JSON off a socket. One serializable
 * {@link Request} in, one serializable {@link Response} out, and the same
 * `Flow` definitions and `FlowEngine` underneath as every other projection.
 *
 * The request may carry a capability envelope. The engine does not interpret
 * envelopes itself — authority is the permission kernel's business — so hosts
 * install an {@link EnvelopeInterpreter} that turns the opaque envelope value
 * into ambient authority around the execution. Handling is fail-closed: a
 * request that names an envelope is refused, not run wide, when no
 * interpreter is installed.
 *
 * Omitting the envelope means "run with whatever authority this host holds",
 * which is only safe while the host's own ceiling is the real bound. A host
 * that serves effectful flows to callers it does not already trust with its
 * full ceiling names those flows in {@link ServeOptions.requireEnvelope}, and
 * an unenveloped request for one is refused as `missing` before the flow runs.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Flow from "./Flow.ts"
import type { FlowEngine } from "./FlowEngine.ts"

/**
 * One serializable flow execution request.
 *
 * `payload` is the flow payload in its JSON encoding. `envelope` is an opaque
 * serialized capability envelope; the engine hands it to the installed
 * {@link EnvelopeInterpreter} without reading it.
 *
 * @category models
 * @since 0.1.0
 */
export class Request extends Schema.Class<Request>("@smithers/engine/FlowWire/Request")({
  flow: Schema.String,
  payload: Schema.Json,
  executionId: Schema.optional(Schema.String),
  envelope: Schema.optional(Schema.Json)
}) {}

/**
 * The request named a flow the serving runtime does not register.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowNotFound extends Schema.TaggedErrorClass<FlowNotFound>()(
  "@smithers/engine/FlowWire/FlowNotFound",
  {
    flow: Schema.String
  }
) {}

/**
 * The request's envelope could not become authority.
 *
 * `unsupported` — the serving runtime has no {@link EnvelopeInterpreter}.
 * `uninterpretable` — the interpreter rejected the envelope value.
 * `missing` — the flow requires an envelope and the request named none, so
 * the host refuses rather than lending the caller its own ceiling.
 * All three refuse execution; an envelope is never silently ignored, and its
 * absence is never silently upgraded to ambient authority.
 *
 * @category errors
 * @since 0.1.0
 */
export class EnvelopeRejected extends Schema.TaggedErrorClass<EnvelopeRejected>()(
  "@smithers/engine/FlowWire/EnvelopeRejected",
  {
    code: Schema.Literals(["unsupported", "uninterpretable", "missing"]),
    message: Schema.String
  }
) {}

/**
 * The request value itself did not decode.
 *
 * @category errors
 * @since 0.1.0
 */
export class RequestInvalid extends Schema.TaggedErrorClass<RequestInvalid>()(
  "@smithers/engine/FlowWire/RequestInvalid",
  {
    message: Schema.String
  }
) {}

/**
 * A request refused before the flow ran. No durable boundary was opened.
 *
 * @category models
 * @since 0.1.0
 */
export class Rejected extends Schema.Class<Rejected>("@smithers/engine/FlowWire/Rejected")({
  _tag: Schema.tag("Rejected"),
  reason: Schema.Union([RequestInvalid, FlowNotFound, EnvelopeRejected])
}) {}

/**
 * A request that reached the flow. `exit` is the flow's `Exit` in the JSON
 * encoding of the flow's own success and error schemas.
 *
 * @category models
 * @since 0.1.0
 */
export class Completed extends Schema.Class<Completed>("@smithers/engine/FlowWire/Completed")({
  _tag: Schema.tag("Completed"),
  exit: Schema.Json
}) {}

/**
 * One serializable flow execution response.
 *
 * @category models
 * @since 0.1.0
 */
export const Response = Schema.Union([Completed, Rejected])

/**
 * One serializable flow execution response.
 *
 * @category models
 * @since 0.1.0
 */
export type Response = typeof Response.Type

/**
 * Turns a serialized capability envelope into ambient authority around one
 * execution.
 *
 * The engine defines only the seam. The canonical implementation decodes the
 * value with `@smithers/kernel`'s `CapabilityEnvelope` and intersects the
 * current `CapabilitySet`, so an envelope can only narrow what the executing
 * host already allows.
 *
 * @category services
 * @since 0.1.0
 */
export class EnvelopeInterpreter extends Context.Service<
  EnvelopeInterpreter,
  {
    readonly apply: (
      envelope: Schema.Json
    ) => <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | EnvelopeRejected, R>
  }
>()("@smithers/engine/FlowWire/EnvelopeInterpreter") {}

/**
 * Builds an interpreter layer from an envelope decoder.
 *
 * The decoder validates the untrusted wire value and returns the pure
 * attenuation combinator to wrap around the execution. Splitting decoding
 * from wrapping is what keeps failures honest: a decoding failure becomes an
 * `uninterpretable` refusal, while failures of the wrapped execution pass
 * through untouched.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInterpreter = (
  decode: (
    envelope: Schema.Json
  ) => Effect.Effect<
    <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    { readonly message: string }
  >
): Layer.Layer<EnvelopeInterpreter> =>
  Layer.succeed(EnvelopeInterpreter)({
    apply: (envelope) => (effect) =>
      decode(envelope).pipe(
        Effect.mapError((failure) => new EnvelopeRejected({ code: "uninterpretable", message: failure.message })),
        Effect.flatMap((attenuate) => attenuate(effect))
      )
  })

const exitSchema = (flow: Flow.AnyWithProps) =>
  Schema.toCodecJson(
    Schema.Exit(flow.successSchema, flow.errorSchema, Schema.Defect())
  )

const decodeRequest = Schema.decodeUnknownEffect(Request)

/**
 * How a placement serves its flows.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServeOptions {
  /**
   * The flows that refuse a request carrying no envelope.
   *
   * An omitted envelope means "run under this host's own ceiling", which is
   * the right default only when every caller of the transport is already
   * trusted with that ceiling. Naming an effectful flow here makes the
   * envelope load-bearing instead of implicit: the caller must state the
   * authority it is exercising, and the host's ceiling then narrows it
   * further. Flows not named here keep the ambient-authority default, which is
   * what a pure flow wants.
   */
  readonly requireEnvelope?: ReadonlyArray<string> | undefined
}

/**
 * Builds the one serving function every placement shares.
 *
 * A Service Worker calls it from a message listener, an edge worker from its
 * `fetch` handler, a local process from an HTTP route, a sandbox guest from
 * its socket loop — the decoding, envelope handling, execution, and exit
 * encoding are identical because they are this function.
 *
 * Envelope refusals raised by the interpreter come back as a {@link Rejected}
 * response rather than an encoded flow failure, so a caller can always tell
 * "the request was refused" apart from "the flow ran and failed".
 *
 * @category constructors
 * @since 0.1.0
 */
export const serve = <const Flows extends ReadonlyArray<Flow.Any>>(
  flows: Flows,
  options?: ServeOptions
): (input: unknown) => Effect.Effect<Response, never, FlowEngine | Flow.RequirementsClient<Flows[number]>> => {
  const mustCarryEnvelope = new Set(options?.requireEnvelope ?? [])
  const byTag = new Map<string, Flow.AnyWithProps>()
  for (const flow of flows) {
    byTag.set(flow._tag, flow as Flow.AnyWithProps)
  }
  return (input) =>
    Effect.gen(function*() {
      const decoded = yield* Effect.result(decodeRequest(input))
      if (decoded._tag === "Failure") {
        return new Rejected({
          reason: new RequestInvalid({
            message: `The flow wire request did not decode: ${decoded.failure.message}`
          })
        })
      }
      const request = decoded.success
      const flow = byTag.get(request.flow)
      if (flow === undefined) {
        return new Rejected({ reason: new FlowNotFound({ flow: request.flow }) })
      }

      // Asked before the payload is even decoded: whether the caller stated
      // its authority is a property of the request, not of what it carries.
      if (request.envelope === undefined && mustCarryEnvelope.has(request.flow)) {
        return new Rejected({
          reason: new EnvelopeRejected({
            code: "missing",
            message:
              `The flow ${request.flow} requires a capability envelope; refusing to run it with this host's ambient authority`
          })
        })
      }

      const payload = yield* Effect.result(
        Schema.decodeUnknownEffect(Schema.toCodecJson(flow.payloadSchema))(request.payload)
      )
      if (payload._tag === "Failure") {
        return new Rejected({
          reason: new RequestInvalid({
            message: `The payload for flow ${request.flow} did not decode: ${payload.failure.message}`
          })
        })
      }

      let run: Effect.Effect<unknown, unknown> = flow.execute(payload.success, {
        executionId: request.executionId
      }) as Effect.Effect<unknown, unknown>

      if (request.envelope !== undefined) {
        const interpreter = yield* Effect.serviceOption(EnvelopeInterpreter)
        if (Option.isNone(interpreter)) {
          return new Rejected({
            reason: new EnvelopeRejected({
              code: "unsupported",
              message: "This runtime has no envelope interpreter installed; refusing to run with ambient authority"
            })
          })
        }
        run = interpreter.value.apply(request.envelope)(run)
      }

      const exit = yield* Effect.exit(run)
      const refusal = envelopeRefusal(exit)
      if (refusal !== undefined) {
        return new Rejected({ reason: refusal })
      }
      const encoded = yield* Effect.orDie(
        Schema.encodeEffect(exitSchema(flow))(exit as Exit.Exit<any, any>)
      )
      return new Completed({ exit: encoded })
    }) as Effect.Effect<Response, never, FlowEngine | Flow.RequirementsClient<Flows[number]>>
}

/**
 * One serialized HTTP projection of a wire response.
 *
 * @category models
 * @since 0.1.0
 */
export interface HttpResponse {
  readonly status: 200 | 400 | 403 | 404
  readonly body: string
}

const statusOf = (response: Response): HttpResponse["status"] =>
  response._tag === "Completed"
    ? 200
    : response.reason instanceof FlowNotFound
    ? 404
    : response.reason instanceof EnvelopeRejected
    ? 403
    : 400

/**
 * Builds the HTTP body-in, body-out projection of the serving function.
 *
 * An edge worker's `fetch` handler and a local process's HTTP route differ
 * only in how they read the request body and write the response — the JSON
 * decoding, envelope handling, execution, and status mapping are this
 * function. Statuses: `200` the flow ran (the encoded exit carries success or
 * typed failure), `400` invalid request, `403` refused envelope, `404`
 * unknown flow. The body is always the encoded {@link Response}, so clients
 * decode uniformly regardless of status.
 *
 * @category constructors
 * @since 0.1.0
 */
export const serveHttp = <const Flows extends ReadonlyArray<Flow.Any>>(
  flows: Flows,
  options?: ServeOptions
): (body: string) => Effect.Effect<HttpResponse, never, FlowEngine | Flow.RequirementsClient<Flows[number]>> => {
  const handler = serve(flows, options)
  return (body) =>
    Effect.gen(function*() {
      const parsed = yield* Effect.result(Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: (cause) => new RequestInvalid({ message: `The request body is not JSON: ${String(cause)}` })
      }))
      const response = parsed._tag === "Failure"
        ? new Rejected({ reason: parsed.failure })
        : yield* handler(parsed.success)
      const encoded = yield* Effect.orDie(Schema.encodeEffect(Response)(response))
      return { status: statusOf(response), body: JSON.stringify(encoded) }
    })
}

const envelopeRefusal = (
  exit: Exit.Exit<unknown, unknown>
): EnvelopeRejected | undefined => {
  if (!Exit.isFailure(exit)) {
    return undefined
  }
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof EnvelopeRejected) {
      return reason.error
    }
  }
  return undefined
}

const decodeResponse = Schema.decodeUnknownEffect(Response)

const describeReason = (
  reason: RequestInvalid | FlowNotFound | EnvelopeRejected
): string =>
  reason instanceof EnvelopeRejected
    ? `${reason._tag} (${reason.code}): ${reason.message}`
    : reason instanceof FlowNotFound
    ? `${reason._tag}: ${reason.flow}`
    : `${reason._tag}: ${reason.message}`

/**
 * A failure of the transport carrying a wire request, or a refusal from the
 * serving side.
 *
 * @category errors
 * @since 0.1.0
 */
export class WireError extends Schema.TaggedErrorClass<WireError>()(
  "@smithers/engine/FlowWire/WireError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.Union([RequestInvalid, FlowNotFound, EnvelopeRejected])),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Builds a typed client over any request-in, response-out transport.
 *
 * The transport is one function — post JSON, receive JSON. Placements differ
 * only in what that function does: call the serving function in-process,
 * `postMessage` to a Service Worker, `fetch` an edge or sandbox endpoint.
 *
 * @category constructors
 * @since 0.1.0
 */
export const client = (
  post: (request: unknown) => Effect.Effect<unknown, WireError>
) =>
<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  flow: Flow.Flow<Tag, Payload, Success, Error>,
  payload: Payload["Type"],
  options?: {
    readonly executionId?: string | undefined
    readonly envelope?: Schema.Json | undefined
  }
): Effect.Effect<Success["Type"], Error["Type"] | WireError> =>
  Effect.gen(function*() {
    const flowProps = flow as unknown as Flow.AnyWithProps
    const encodedPayload = yield* Effect.orDie(
      Schema.encodeEffect(Schema.toCodecJson(flowProps.payloadSchema))(payload)
    )
    const request: Record<string, unknown> = {
      flow: flow._tag,
      payload: encodedPayload
    }
    if (options?.executionId !== undefined) {
      request.executionId = options.executionId
    }
    if (options?.envelope !== undefined) {
      request.envelope = options.envelope
    }
    const raw = yield* post(request)
    const response = yield* Effect.orDie(decodeResponse(raw))
    if (response._tag === "Rejected") {
      return yield* Effect.fail(
        new WireError({
          message: `The flow wire request was rejected: ${describeReason(response.reason)}`,
          reason: response.reason
        })
      )
    }
    const exit = (yield* Effect.orDie(
      Schema.decodeUnknownEffect(exitSchema(flowProps))(response.exit)
    )) as Exit.Exit<Success["Type"], Error["Type"]>
    if (Exit.isSuccess(exit)) {
      return exit.value
    }
    return yield* Effect.failCause(exit.cause)
  }) as Effect.Effect<Success["Type"], Error["Type"] | WireError>
