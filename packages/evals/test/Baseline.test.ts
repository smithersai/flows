import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Baseline from "../src/Baseline.ts"

describe("Baseline", () => {
  it("writes sorted canonical JSON and validates its version", async () => {
    const baseline = await Effect.runPromise(
      Baseline.load(
        "{\"version\":1,\"records\":[{\"suite\":\"s\",\"case\":\"c\",\"scorer\":\"x\",\"stepKey\":\"k\",\"score\":0.5}]}"
      )
    )
    expect(Baseline.write(baseline)).toBe(
      "{\"records\":[{\"case\":\"c\",\"score\":0.5,\"scorer\":\"x\",\"stepKey\":\"k\",\"suite\":\"s\"}],\"version\":1}\n"
    )
    const bad = await Effect.runPromiseExit(Baseline.load("{\"version\":2,\"records\":[]}"))
    expect(bad._tag).toBe("Failure")
  })
})
