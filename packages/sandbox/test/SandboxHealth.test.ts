import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ProviderError } from "../src/RemoteSandbox.ts"
import * as SandboxHealth from "../src/SandboxHealth.ts"

const healthyProvider: SandboxHealth.PingProvider = {
  ping: Effect.void
}

const deadProvider: SandboxHealth.PingProvider = {
  // A dead sandbox never answers: the ping hangs forever.
  ping: Effect.never
}

const refusingProvider: SandboxHealth.PingProvider = {
  ping: Effect.fail(
    new ProviderError({ code: "shell_unavailable", message: "session is gone" })
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
