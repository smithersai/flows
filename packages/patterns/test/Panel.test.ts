import { describe, it } from "@effect/vitest"
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Panel from "../src/Panel.ts"
import { PatternError } from "../src/PatternError.ts"

const participant = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Panel", () => {
  it("declares keyed fan-out with a valid quorum", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant },
      moderator: participant,
      quorum: 1
    })

    expect(Flow.isFlow(panel)).toBe(true)
    expect(panel.body?.("topic").ast._tag).toBe("AndThen")
  })

  it("rejects quorum above panel size", () => {
    expect(() => Panel.make({ panelists: { one: participant }, moderator: participant, quorum: 2 })).toThrow(
      PatternError
    )
  })
})
