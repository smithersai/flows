import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Request from "@smthrs/model/ModelRequest"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as ContextWindow from "../src/ContextWindow.ts"

const system = Request.SystemPart.make({ text: "Be concise." })
const tool = Request.ToolDefinition.make({ name: "read", description: "Read", parameters: {} })

const base = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "instructions", zone: "prefix", content: [Request.SystemPart.make({ text: "Follow instructions" })] },
      { kind: "tools", zone: "prefix", content: [tool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("first")] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("second")] }
    ],
    activeTools: ["read"]
  })

describe("ContextWindow", () => {
  it("has a deterministic digest and never mutates its input", () => {
    const first = base()
    const second = base()
    const next = ContextWindow.appendTurn(first, Request.Message.assistant("working"), [])
    expect(first.digest).toBe(second.digest)
    expect(next.digest).not.toBe(first.digest)
    expect(first.segments).toHaveLength(5)
  })

  it("uses the canonical keys SHA-256 digest for window identity", () => {
    const value = base()
    expect(value.digest).toBe(
      Digest.digest(CanonicalJson.stringify({
        modelId: value.modelId,
        segments: value.segments.map((segment) => segment.digest),
        activeTools: value.activeTools
      }))
    )
  })

  it("activates tools additively without changing the stable prefix", () => {
    const value = base()
    const activated = ContextWindow.activateTools(value, ["read", "read"])
    expect(activated.activeTools).toEqual(["read"])
    expect(activated.segments[0]).toEqual(value.segments[0])
    expect(activated.segments[1]).toEqual(value.segments[1])
    expect(ContextWindow.activateTools(activated, ["read"])).toBe(activated)
    expect(ContextWindow.activateTools(activated, [" READ "])).toBe(activated)
  })

  it("keeps token accounting aligned with segments", () => {
    const value = base()
    const sum = value.tokens.bySegment.reduce((total, segment) => total + segment.tokens.value, 0)
    expect(value.tokens.total.value).toBe(sum)
    expect(value.tokens.total.estimated).toBe(true)
  })

  it("compacts the transcript prefix and renders a valid request", () => {
    const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
    const request = ContextWindow.render(compacted)
    expect(compacted.replaced).toBeDefined()
    expect(request.messages.map((message) => message.content.find((part) => "text" in part)?.text)).toEqual([
      "summary",
      "second"
    ])
    expect(request.tools.map((definition) => definition.name)).toEqual(["read"])
  })

  it("returns a stable typed error for an invalid compaction prefix", () => {
    const result = ContextWindow.prefixDigest(base(), -1)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        code: "invalid_compaction_prefix"
      })
    }
  })
})
