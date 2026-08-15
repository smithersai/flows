import { describe, expect, it } from "vitest"
import * as ToolStream from "../src/ToolStream.ts"

describe("ToolStream", () => {
  it("reassembles JSON fragments", () => {
    let state = ToolStream.initial()
    state = ToolStream.start(state, { callId: "call_1", name: "lookup" })
    state = ToolStream.delta(state, "call_1", "{\"query\":")
    state = ToolStream.delta(state, "call_1", "\"flows\"")
    state = ToolStream.delta(state, "call_1", "}")

    const result = ToolStream.end(state, "call_1")
    if (result instanceof Error) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "lookup", arguments: "{\"query\":\"flows\"}" })
    expect(result.state).toEqual({ open: [] })
  })

  it("rejects malformed provider argument JSON", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "lookup" })
    state = ToolStream.delta(state, "call_1", "{")

    const result = ToolStream.end(state, "call_1")
    expect(result).toMatchObject({ code: "invalid_provider_output" })
  })

  it("settles open calls with valid synthetic arguments after an abort", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "partial", name: "one" })
    state = ToolStream.delta(state, "partial", "{\"not\":\"complete\"")
    state = ToolStream.start(state, { callId: "empty", name: "two" })

    expect(ToolStream.flushAborted(state)).toEqual({
      state: { open: [] },
      completed: [
        { callId: "partial", name: "one", arguments: "{}" },
        { callId: "empty", name: "two", arguments: "{}" }
      ]
    })
  })
})
