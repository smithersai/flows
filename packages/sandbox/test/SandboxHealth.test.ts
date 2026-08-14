import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
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

  it("maps a ping that never answers to Unhealthy(sandbox, unresponsive) at the configured deadline", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const probe = yield* SandboxHealth.probe(deadProvider, { deadline: "50 millis" }).pipe(Effect.forkChild)
        yield* TestClock.adjust("49 millis")
        const beforeDeadline = probe.pollUnsafe()
        yield* TestClock.adjust("1 milli")
        const atDeadline = yield* Fiber.join(probe)
        return { beforeDeadline, atDeadline }
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(state.beforeDeadline).toBeUndefined()
    expect(state.atDeadline._tag).toBe("Unhealthy")
    if (state.atDeadline._tag === "Unhealthy") {
      expect(state.atDeadline.component).toBe("sandbox")
      expect(state.atDeadline.reason).toBe("unresponsive")
    }
  })

  it("pins the default deadline: a 4.999s ping is healthy while a hanging ping times out at 5s", async () => {
    const states = await Effect.runPromise(
      Effect.gen(function*() {
        const justInTime = yield* SandboxHealth.probe({ ping: Effect.sleep("4999 millis") }).pipe(Effect.forkChild)
        const hanging = yield* SandboxHealth.probe(deadProvider).pipe(Effect.forkChild)
        yield* TestClock.adjust("4999 millis")
        const healthy = yield* Fiber.join(justInTime)
        const stillPending = hanging.pollUnsafe()
        yield* TestClock.adjust("1 milli")
        const unresponsive = yield* Fiber.join(hanging)
        return { healthy, stillPending, unresponsive }
      }).pipe(Effect.provide(TestClock.layer()))
    )

    expect(states.healthy._tag).toBe("Healthy")
    expect(states.stillPending).toBeUndefined()
    expect(states.unresponsive._tag).toBe("Unhealthy")
    if (states.unresponsive._tag === "Unhealthy") {
      expect(states.unresponsive.reason).toBe("unresponsive")
    }
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
        const check = yield* health.check.pipe(Effect.forkChild)
        yield* TestClock.adjust("50 millis")
        return yield* Fiber.join(check)
      }).pipe(
        Effect.provide(SandboxHealth.layer(deadProvider, { deadline: "50 millis" })),
        Effect.provide(TestClock.layer())
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

  it("returns a consistent state for sequential checks on one provider", async () => {
    let pings = 0
    const service = SandboxHealth.make({
      ping: Effect.sync(() => {
        pings += 1
      })
    })

    const states = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* service.check
        const second = yield* service.check
        return [first, second]
      })
    )

    expect(states.map((state) => state._tag)).toEqual(["Healthy", "Healthy"])
    expect(pings).toBe(2)
  })
})
