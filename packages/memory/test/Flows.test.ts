import * as Flow from "@smthrs/core/Flow"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/Flows.ts"

describe("Flows", () => {
  it("declares remember and recall as unsealed flows without bodies", () => {
    expect(Flows.remember.name).toBe("remember")
    expect(Flows.recall.name).toBe("recall")
    expect(Flows.remember.body).toBeUndefined()
    expect(Flows.recall.body).toBeUndefined()
    expect(Flows.remember.effects?.tier).not.toBe("sealed")
    expect(Flows.recall.effects?.tier).not.toBe("sealed")
  })

  it("exposes a bindable recall slot and concrete runtime handlers", () => {
    const binding = Flow.make({
      input: Flows.RecallInput,
      output: Flows.RecallOutput
    })
    expect(Flows.bindRecall(binding)).toBe(binding)
    expect(Flows.handlers).toMatchObject({
      remember: expect.any(Function),
      recall: expect.any(Function)
    })
  })
})
