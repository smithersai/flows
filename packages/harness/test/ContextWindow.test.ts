import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Request from "@smthrs/model/ModelRequest"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as ContextWindow from "../src/ContextWindow.ts"

const system = Request.SystemPart.make({ text: "Be concise." })
const tool = Request.ToolDefinition.make({ name: "read", description: "Read", parameters: {} })
const lazyTool = Request.ToolDefinition.make({
  name: "write",
  description: "Write",
  parameters: {},
  deferred: true
})

/** The window with a lazily loaded tool declared but not yet activated. */
const lazy = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "tools", zone: "prefix", content: [tool, lazyTool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("load a tool")] }
    ],
    activeTools: []
  })

/** The identity a provider caches: the digests of the prefix-zone segments. */
const sealedPrefix = (value: ContextWindow.ContextWindow) =>
  value.segments.filter((segment) => segment.zone === "prefix").map((segment) => segment.digest)

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
    const value = lazy()
    const first = ContextWindow.activateTools(value, ["read", "read"])
    const second = ContextWindow.activateTools(first, ["write"])

    // Each activation adds, and adds only what the window did not already hold.
    expect(value.activeTools).toEqual([])
    expect(first.activeTools).toEqual(["read"])
    expect(second.activeTools).toEqual(["read", "write"])
    expect(first).not.toBe(value)
    expect(first.digest).not.toBe(value.digest)

    // Activation never rewrites a sealed segment, so the cached prefix survives.
    expect(sealedPrefix(second)).toEqual(sealedPrefix(value))
    expect(second.tokens.prefix).toEqual(value.tokens.prefix)

    // A redundant activation keeps the object, and with it the window digest.
    expect(ContextWindow.activateTools(second, ["read"])).toBe(second)
    expect(ContextWindow.activateTools(second, [" WRITE "])).toBe(second)
  })

  it("renders the same prefix when a lazily loaded tool activates", () => {
    const value = lazy()
    const activated = ContextWindow.activateTools(value, ["write"])
    const before = ContextWindow.render(value)
    const after = ContextWindow.render(activated)

    // A deferred declaration is advertised before and after activation, so the
    // prefix the provider caches is unchanged by loading the tool.
    expect(after.tools.map((definition) => definition.name)).toEqual(["write"])
    expect(after.modelId).toBe(before.modelId)
    expect(after.system).toEqual(before.system)
    expect(after.messages).toEqual(before.messages)
    expect(after.tools).toEqual(before.tools)
  })

  it("appends a tool message carrying the ordered results after the assistant turn", () => {
    const assistant = Request.Message.assistant(
      Request.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{\"path\":\"a\"}" }),
      { stopReason: "tool-calls" }
    )
    const result = Request.ToolResultPart.make({ toolCallId: "call-1", content: "file contents" })
    const next = ContextWindow.appendTurn(base(), assistant, [result])

    const appended = next.segments[next.segments.length - 1]
    expect(appended?.kind).toBe("transcript")
    expect(appended?.zone).toBe("tail")
    expect(appended?.content).toEqual([assistant, Request.Message.tool([result])])

    const request = ContextWindow.render(next)
    expect(request.messages.slice(-2).map((message) => message.role)).toEqual(["assistant", "tool"])
    expect(request.messages[request.messages.length - 1]?.content).toEqual([result])
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
