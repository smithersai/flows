import { Cause, Effect, Logger, References, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import { ProviderError } from "../src/RemoteChildProcessSpawner/index.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

const healthyProvider: SandboxHealth.PingProvider = {
  ping: Effect.void
}

const deadProvider: SandboxHealth.PingProvider = {
  // A dead sandbox never answers: the ping hangs forever.
  ping: Effect.never
}

const refusingProvider: SandboxHealth.PingProvider = {
  ping: Effect.fail(
    new ProviderError({ code: "unavailable", message: "session is gone" })
  )
}

describe("SandboxHealth.probe", () => {
  it("reports Healthy when the provider ping answers within the deadline", async () => {
    const state = await Effect.runPromise(
      SandboxHealth.probe(healthyProvider, { deadline: "1 second" })
    )
    expect(state._tag).toBe("Healthy")
  })

  it("maps a ping that never answers to Unhealthy(sandbox, unresponsive) within the deadline", async () => {
    const started = Date.now()
    const state = await Effect.runPromise(
      SandboxHealth.probe(deadProvider, { deadline: "50 millis" })
    )
    expect(state._tag).toBe("Unhealthy")
    if (state._tag === "Unhealthy") {
      expect(state.component).toBe("sandbox")
      expect(state.reason).toBe("unresponsive")
    }
    // The probe itself answers promptly — this is what distinguishes a dead
    // sandbox from a slow command.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("maps a failed ping to Unhealthy(sandbox, ping_failed) carrying the provider message", async () => {
    const state = await Effect.runPromise(SandboxHealth.probe(refusingProvider))
    expect(state._tag).toBe("Unhealthy")
    if (state._tag === "Unhealthy") {
      expect(state.component).toBe("sandbox")
      expect(state.reason).toBe("ping_failed")
      expect(state.message).toBe("session is gone")
    }
  })

  it("opens one SandboxHealth.probe span annotated with the outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    await Effect.runPromise(
      Effect.gen(function*() {
        yield* SandboxHealth.probe(healthyProvider, { deadline: "1 second" })
        yield* SandboxHealth.probe(refusingProvider)
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    expect(
      spans.filter((span) => span.name === "SandboxHealth.probe").map((span) => span.attributes.get("outcome"))
    ).toEqual(["healthy", "ping_failed"])
  })

  it("logs the full ping failure cause instead of flattening it to the message", async () => {
    const causes: Array<Cause.Cause<unknown>> = []
    const capture = Logger.make((options) => {
      if (String(options.message).includes("sandbox ping failed")) causes.push(options.cause)
    })

    await Effect.runPromise(
      SandboxHealth.probe(refusingProvider).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )

    const errors = causes.flatMap((cause) => cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(ProviderError)
    expect((errors[0] as ProviderError).code).toBe("unavailable")
  })
})

describe("SandboxHealth service", () => {
  it("check probes through the layer-provided service", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const health = yield* SandboxHealth.SandboxHealth
        return yield* health.check
      }).pipe(
        Effect.provide(SandboxHealth.layer(deadProvider, { deadline: "50 millis" }))
      )
    )
    expect(state._tag).toBe("Unhealthy")
  })

  it("layerNoop always reports Healthy for hosts without a remote sandbox", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const health = yield* SandboxHealth.SandboxHealth
        return yield* health.check
      }).pipe(Effect.provide(SandboxHealth.layerNoop))
    )
    expect(state._tag).toBe("Healthy")
  })

  it("make builds a working service without a layer", async () => {
    const service = SandboxHealth.make(healthyProvider)
    const state = await Effect.runPromise(service.check)
    expect(state).toBeInstanceOf(SandboxHealth.Healthy)
  })
})
