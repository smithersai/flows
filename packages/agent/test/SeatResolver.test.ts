/**
 * The seat vocabulary and the host seam that serves it.
 *
 * A live run in `AgentSession.test.ts` covers a resolver that answers; these
 * cases pin the parts a run never exercises: the model id read out of a
 * declared seat string, the context window catalogue, and the refusal a
 * composition with no configured resolver gives.
 *
 * There is nothing here about the shape of a seat string. The resolver owns
 * that vocabulary, so the agent validates nothing.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

describe("Seat.modelIdOf", () => {
  it("reads the half after the separator", () => {
    expect(Seat.modelIdOf("anthropic:claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    // Only the first separator splits; a model id may contain more.
    expect(Seat.modelIdOf("openai:org:gpt-5")).toBe("org:gpt-5")
  })

  it("reads a seat with no separator as its own model id", () => {
    expect(Seat.modelIdOf("test-model")).toBe("test-model")
  })
})

describe("SeatResolver.contextWindowTokensFor", () => {
  it("resolves a context window for every catalogued model and a floor for the rest", () => {
    expect(SeatResolver.contextWindowTokensFor("claude-sonnet-4-5")).toBe(200_000)
    expect(SeatResolver.contextWindowTokensFor("gpt-5")).toBe(400_000)
    expect(SeatResolver.contextWindowTokensFor("gpt-4.1-mini")).toBe(1_000_000)
    expect(SeatResolver.contextWindowTokensFor("gpt-4o")).toBe(128_000)
    expect(SeatResolver.contextWindowTokensFor("o3-mini")).toBe(200_000)
    // Never zero: zero is CellTurn's "compaction disabled".
    expect(SeatResolver.contextWindowTokensFor("somebody-elses-model")).toBe(128_000)
  })
})

describe("SeatResolver service", () => {
  it("refuses every seat by default, because an unconfigured host holds no credential", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(SeatResolver.makeNoop().resolve("anthropic:claude-sonnet-4-5"))
    )
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.seat).toBe("anthropic:claude-sonnet-4-5")
    expect(failure.message).toBe("No seat resolver is configured")
  })

  it("takes an override for its one method, as a value and as a layer", async () => {
    const model = { stream: () => Effect.die("unused") } as never
    const route = { prepare: () => Effect.die("unused") } as never
    const resolved = Seat.make({ id: "test:model", model, route, contextWindowTokens: 128_000 })

    const overridden = SeatResolver.makeNoop({ resolve: () => Effect.succeed(resolved) })
    expect(await Effect.runPromise(overridden.resolve("test:model"))).toBe(resolved)

    const layered = await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        return yield* seats.resolve("test:model")
      }).pipe(Effect.provide(SeatResolver.layerNoop({ resolve: () => Effect.succeed(resolved) })))
    )
    expect(layered).toBe(resolved)

    const provided = await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        return yield* seats.resolve("test:model")
      }).pipe(Effect.provide(SeatResolver.layer({ resolve: () => Effect.succeed(resolved) })))
    )
    expect(provided).toBe(resolved)
  })
})
