import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Scorer from "../src/Scorer.ts"

describe("Scorer", () => {
  it("has an independent declaration key and validates scores", async () => {
    const scorer = Scorer.make({
      name: "quality",
      score: () => Effect.succeed({ score: 1 })
    })
    expect(scorer.scorerKey).toMatch(/^[0-9a-f]{8}$/)
    await expect(
      Effect.runPromise(Scorer.validate({ score: 2, reason: "bad" }))
    ).rejects.toMatchObject({ code: "invalid_score" })
  })
})
