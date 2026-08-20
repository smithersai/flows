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
  it("declares keyed fail-fast fan-out", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant },
      moderator: participant
    })

    expect(Flow.isFlow(panel)).toBe(true)
    expect(panel.body?.("topic").ast._tag).toBe("AndThen")
  })

  it("rejects an empty panel", () => {
    expect(() => Panel.make({ panelists: {}, moderator: participant })).toThrow(PatternError)
  })
})
