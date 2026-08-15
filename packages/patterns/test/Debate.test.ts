import { describe, it } from "@effect/vitest"
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Debate from "../src/Debate.ts"
import { PatternError } from "../src/PatternError.ts"

const participant = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Debate", () => {
  it("declares bounded participant and judge calls", () => {
    const debate = Debate.make({
      proponent: participant,
      opponent: participant,
      judge: participant,
      rounds: 2
    })

    expect(Flow.isFlow(debate)).toBe(true)
    expect(debate.body?.("topic").ast._tag).toBe("AndThen")
  })

  it("rejects an unbounded round count", () => {
    expect(() => Debate.make({ proponent: participant, opponent: participant, judge: participant, rounds: 0 })).toThrow(
      PatternError
    )
  })
})
