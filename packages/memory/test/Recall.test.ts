import { describe, expect, it } from "vitest"
import * as Recall from "../src/Recall.ts"

describe("Recall", () => {
  it("caps whole results and truncates only the first overflowing result", () => {
    const results = [
      { bank: "a", key: "one", text: "short", score: 1 },
      { bank: "b", key: "two", text: "a long result that must be truncated", score: 0.5 },
      { bank: "c", key: "three", text: "never reached", score: 0.1 }
    ]
    const capped = Recall.capRecallResults(results, 105)
    expect(capped).toHaveLength(2)
    expect(capped[0]).toEqual(results[0])
    const overflowing = results[1]
    expect(overflowing).toBeDefined()
    if (overflowing === undefined) return
    expect(capped[1]?.text.length).toBeLessThan(overflowing.text.length)
  })

  it.each([
    [0, 0],
    [-1, 0],
    [Number.NaN, 0]
  ])("uses a non-negative byte budget (%s)", (budget, expected) => {
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "text", score: 1 }], budget)).toHaveLength(expected)
  })
})
