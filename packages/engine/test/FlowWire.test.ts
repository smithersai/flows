import { Context, Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Flow, FlowEngine, FlowWire } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body() as Effect.Effect<void, unknown, never>))

/**
 * A stand-in for kernel ambient authority: a fiber `Context.Reference` the
 * interpreter narrows, exactly the shape `CapabilitySet.attenuate` has. The
 * engine test must not depend on `@smithers/kernel`, so the reference is
 * local.
 */
const Authority = Context.Reference<ReadonlyArray<string>>(
  "test/FlowWire/Authority",
  { defaultValue: () => ["*"] }
)

const Echo = Flow.make("Wire/Echo", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("negative"),
  idempotencyKey: ({ value }) => String(value)
})

const Observe = Flow.make("Wire/Observe", {
  payload: { probe: Schema.String },
  success: Schema.Struct({ granted: Schema.Boolean }),
  idempotencyKey: ({ probe }) => probe
})

const flows = [Echo, Observe] as const

const handlers = Layer.mergeAll(
  Echo.toLayer(({ value }) => value < 0 ? Effect.fail("negative" as const) : Effect.succeed(value + 1)),
  Observe.toLayer(({ probe }) =>
    Effect.gen(function*() {
      const authority = yield* Authority
      return { granted: authority.includes("*") || authority.includes(probe) }
    })
  )
).pipe(Layer.provideMerge(FlowEngine.layerMemory))

/**
 * The test interpreter reads `{ allow: [...] }` envelopes and replaces the
 * wildcard authority with the envelope's list — monotone in spirit, minimal
 * in mechanics.
 */
const EnvelopeSchema = Schema.Struct({ allow: Schema.Array(Schema.String) })

const interpreter = FlowWire.layerInterpreter((envelope) =>
  Schema.decodeUnknownEffect(EnvelopeSchema)(envelope).pipe(
    Effect.mapError((error) => ({ message: error.message })),
    Effect.map((decoded) => <A, E, R>(wrapped: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.updateService(wrapped, Authority, (current) =>
        current.filter((entry) =>
          entry !== "*"
        ).concat(decoded.allow))
    )
  )
)

// The wire is JSON: every request/response crosses a stringify/parse
// boundary, exactly like postMessage or fetch.
const overTheWire = (
  handler: (input: unknown) => Effect.Effect<FlowWire.Response, never, any>
) =>
(request: unknown): Effect.Effect<unknown, FlowWire.WireError> =>
  Effect.gen(function*() {
    const serialized = JSON.parse(JSON.stringify(request))
    const response = yield* handler(serialized)
    const encoded = yield* Effect.orDie(Schema.encodeEffect(FlowWire.Response)(response))
    return JSON.parse(JSON.stringify(encoded))
  }) as unknown as Effect.Effect<unknown, FlowWire.WireError>

describe("FlowWire", () => {
  effect("serves an execute request end to end over JSON", () => {
    const call = FlowWire.client(overTheWire(FlowWire.serve(flows)))
    return Effect.gen(function*() {
      const result = yield* call(Echo, { value: 41 }, { executionId: "wire-echo" })
      expect(result).toBe(42)
      // Without options the execution id derives from the idempotency key.
      const optionless = yield* call(Echo, { value: 10 })
      expect(optionless).toBe(11)
    }).pipe(Effect.provide(interpreter), Effect.provide(handlers))
  })

  effect("returns the flow's typed error through the wire", () => {
    const call = FlowWire.client(overTheWire(FlowWire.serve(flows)))
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(call(Echo, { value: -1 }, { executionId: "wire-negative" }))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("negative")
    }).pipe(Effect.provide(interpreter), Effect.provide(handlers))
  })

  effect("rejects a request for an unregistered flow", () => {
    const serveOnlyEcho = FlowWire.serve([Echo] as const)
    return Effect.gen(function*() {
      const response = yield* serveOnlyEcho({
        flow: "Wire/Observe",
        payload: { probe: "net" },
        executionId: "missing"
      })
      expect(response._tag).toBe("Rejected")
      if (response._tag === "Rejected") {
        expect(response.reason._tag).toBe("@smithers/engine/FlowWire/FlowNotFound")
      }
    }).pipe(Effect.provide(handlers))
  })

  effect("rejects an undecodable request", () => {
    const handler = FlowWire.serve(flows)
    return Effect.gen(function*() {
      const response = yield* handler({ nonsense: true })
      expect(response._tag).toBe("Rejected")
      if (response._tag === "Rejected") {
        expect(response.reason._tag).toBe("@smithers/engine/FlowWire/RequestInvalid")
      }
    }).pipe(Effect.provide(handlers))
  })

  effect("rejects an undecodable payload", () => {
    const handler = FlowWire.serve(flows)
    return Effect.gen(function*() {
      const response = yield* handler({
        flow: "Wire/Echo",
        payload: { value: "not a number" },
        executionId: "bad-payload"
      })
      expect(response._tag).toBe("Rejected")
      if (response._tag === "Rejected") {
        expect(response.reason._tag).toBe("@smithers/engine/FlowWire/RequestInvalid")
      }
    }).pipe(Effect.provide(handlers))
  })

  effect("an envelope narrows the authority the handler observes", () => {
    const call = FlowWire.client(overTheWire(FlowWire.serve(flows)))
    return Effect.gen(function*() {
      const granted = yield* call(Observe, { probe: "net" }, {
        executionId: "enveloped-allow",
        envelope: { allow: ["net"] }
      })
      expect(granted).toEqual({ granted: true })
      const denied = yield* call(Observe, { probe: "fs" }, {
        executionId: "enveloped-deny",
        envelope: { allow: ["net"] }
      })
      expect(denied).toEqual({ granted: false })
      // Without an envelope the ambient wildcard authority applies.
      const ambient = yield* call(Observe, { probe: "fs" }, { executionId: "ambient" })
      expect(ambient).toEqual({ granted: true })
    }).pipe(Effect.provide(interpreter), Effect.provide(handlers))
  })

  effect("fails closed when an envelope arrives and no interpreter is installed", () => {
    const call = FlowWire.client(overTheWire(FlowWire.serve(flows)))
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(call(Observe, { probe: "net" }, {
        executionId: "no-interpreter",
        envelope: { allow: ["net"] }
      }))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("unsupported")
    }).pipe(Effect.provide(handlers))
  })

  effect("fails closed when the interpreter cannot read the envelope", () => {
    const call = FlowWire.client(overTheWire(FlowWire.serve(flows)))
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(call(Observe, { probe: "net" }, {
        executionId: "bad-envelope",
        envelope: { deny: true }
      }))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("uninterpretable")
    }).pipe(Effect.provide(interpreter), Effect.provide(handlers))
  })

  effect("a flow that requires an envelope refuses an unenveloped request", () => {
    const handler = FlowWire.serve(flows, { requireEnvelope: ["Wire/Observe"] })
    return Effect.gen(function*() {
      const refused = yield* handler({
        flow: "Wire/Observe",
        payload: { probe: "fs" },
        executionId: "must-state-authority"
      })
      expect(refused._tag).toBe("Rejected")
      if (refused._tag === "Rejected") {
        expect(refused.reason._tag).toBe("@smithers/engine/FlowWire/EnvelopeRejected")
        expect((refused.reason as FlowWire.EnvelopeRejected).code).toBe("missing")
      }

      // The refusal precedes payload decoding: a caller cannot learn whether
      // its payload was well-formed without first stating its authority.
      const refusedBadPayload = yield* handler({
        flow: "Wire/Observe",
        payload: { probe: 42 },
        executionId: "must-state-authority-bad-payload"
      })
      expect(refusedBadPayload._tag).toBe("Rejected")
      if (refusedBadPayload._tag === "Rejected") {
        expect(refusedBadPayload.reason._tag).toBe("@smithers/engine/FlowWire/EnvelopeRejected")
      }

      // The same request with an envelope runs, narrowed by it.
      const enveloped = yield* handler({
        flow: "Wire/Observe",
        payload: { probe: "fs" },
        executionId: "stated-authority",
        envelope: { allow: ["net"] }
      })
      expect(enveloped._tag).toBe("Completed")
      expect(JSON.stringify(enveloped)).toContain("false")

      // A flow the host did not name keeps the ambient-authority default.
      const unlisted = yield* handler({
        flow: "Wire/Echo",
        payload: { value: 41 },
        executionId: "ambient-still-allowed"
      })
      expect(unlisted._tag).toBe("Completed")
    }).pipe(Effect.provide(interpreter), Effect.provide(handlers))
  })

  effect("the HTTP projection refuses a required-envelope omission as 403", () => {
    const handler = FlowWire.serveHttp(flows, { requireEnvelope: ["Wire/Observe"] })
    return Effect.gen(function*() {
      const refused = yield* handler(JSON.stringify({
        flow: "Wire/Observe",
        payload: { probe: "fs" },
        executionId: "http-must-state-authority"
      }))
      expect(refused.status).toBe(403)
      expect(refused.body).toContain("requires a capability envelope")
    }).pipe(Effect.provide(interpreter), Effect.provide(handlers))
  })

  effect("a client call for an unregistered flow surfaces the flow name", () => {
    const call = FlowWire.client(overTheWire(FlowWire.serve([Echo] as const)))
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(call(Observe, { probe: "net" }, { executionId: "client-missing" }))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("FlowNotFound")
      expect(String(exit)).toContain("Wire/Observe")
    }).pipe(Effect.provide(handlers))
  })

  effect("schema drift between client and server is a refusal, not a crash", () => {
    // The server's "Wire/Echo" takes a string payload; the client still holds
    // the numeric definition. The mismatch must come back as a refusal.
    const DriftedEcho = Flow.make("Wire/Echo", {
      payload: { value: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ value }) => value
    })
    const call = FlowWire.client(overTheWire(FlowWire.serve([DriftedEcho] as const)))
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(call(Echo, { value: 7 }, { executionId: "drift" }))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("RequestInvalid")
      expect(String(exit)).toContain("did not decode")
    }).pipe(Effect.provide(handlers))
  })

  effect("the HTTP projection maps refusals onto statuses and always encodes a response body", () => {
    const handler = FlowWire.serveHttp(flows)
    const decodeBody = (body: string) => Effect.orDie(Schema.decodeUnknownEffect(FlowWire.Response)(JSON.parse(body)))
    return Effect.gen(function*() {
      const completed = yield* handler(JSON.stringify({
        flow: "Wire/Echo",
        payload: { value: 41 },
        executionId: "http-echo"
      }))
      expect(completed.status).toBe(200)
      expect((yield* decodeBody(completed.body))._tag).toBe("Completed")

      // A flow that ran and failed is still a 200: the exit carries the error.
      const failed = yield* handler(JSON.stringify({
        flow: "Wire/Echo",
        payload: { value: -1 },
        executionId: "http-negative"
      }))
      expect(failed.status).toBe(200)

      const notJson = yield* handler("{not json")
      expect(notJson.status).toBe(400)
      const notJsonBody = yield* decodeBody(notJson.body)
      expect(notJsonBody._tag).toBe("Rejected")

      const badPayload = yield* handler(JSON.stringify({
        flow: "Wire/Echo",
        payload: { value: "not a number" },
        executionId: "http-bad"
      }))
      expect(badPayload.status).toBe(400)

      const missing = yield* handler(JSON.stringify({
        flow: "Wire/Missing",
        payload: {},
        executionId: "http-missing"
      }))
      expect(missing.status).toBe(404)

      const enveloped = yield* handler(JSON.stringify({
        flow: "Wire/Echo",
        payload: { value: 1 },
        executionId: "http-enveloped",
        envelope: { allow: ["net"] }
      }))
      expect(enveloped.status).toBe(403)
    }).pipe(Effect.provide(handlers))
  })

  effect("repeated wire requests for one execution id deduplicate", () => {
    let calls = 0
    const Counted = Flow.make("Wire/Counted", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      idempotencyKey: ({ value }) => String(value)
    })
    const layer = Counted.toLayer(({ value }) =>
      Effect.sync(() => {
        calls++
        return value * 2
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    const call = FlowWire.client(overTheWire(FlowWire.serve([Counted] as const)))
    return Effect.gen(function*() {
      const first = yield* call(Counted, { value: 4 }, { executionId: "dedupe" })
      const second = yield* call(Counted, { value: 4 }, { executionId: "dedupe" })
      expect([first, second]).toEqual([8, 8])
      expect(calls).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
