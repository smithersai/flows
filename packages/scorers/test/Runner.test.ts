import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Runner from "../src/Runner.ts"
import * as RunnerLive from "../src/RunnerLive.ts"
import * as ScoreStore from "../src/ScoreStore.ts"

describe("Runner", () => {
  it("turns scorer failures into typed inconclusive observations", async () => {
    const seen: Array<ScoreStore.Observation> = []
    const store = ScoreStore.make({
      record: (value) =>
        Effect.sync(() => {
          seen.push(value)
        }),
      recordOnce: (_identity, value) =>
        Effect.sync(() => {
          seen.push(value)
          return true
        }),
      observations: () => Effect.succeed([]),
      aggregate: () => Effect.succeed(undefined)
    })
    const program = Effect.gen(function*() {
      const runner = yield* Runner.Runner
      return yield* runner.runBatch([{
        identity: "job",
        observation: { targetStepKey: "t", scorerKey: "s" },
        score: Effect.fail("boom"),
        at: 1
      }])
    })
    const output = await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(RunnerLive.layer()),
          Effect.provideService(ScoreStore.ScoreStore, store)
        )
      )
    )
    expect(output[0]).toMatchObject({ kind: "inconclusive", reason: expect.stringContaining("inconclusive") })
    expect(seen).toEqual(output)
  })
})
