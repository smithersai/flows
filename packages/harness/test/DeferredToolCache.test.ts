/**
 * Pi §4 parity: `docs/specs/Research/Pi Reference Findings 2026-07-27.md`.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { DeferredTools, ModelRequest } from "@smthrs/model"
import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Tools from "../src/Tools.ts"

const loader = ModelRequest.ToolDefinition.make({
  name: "search_tools",
  description: "Find a registered tool.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  loader: true
})

const read = ModelRequest.ToolDefinition.make({
  name: "read",
  description: "Read a deferred value.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  deferred: true
})

const write = ModelRequest.ToolDefinition.make({
  name: "write",
  description: "Write a deferred value.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  deferred: true
})

const catalog = Result.getOrThrow(Tools.Catalog.makeResult([loader, read, write]))

const initialContext = (): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: "gpt-5.4",
    segments: [
      {
        kind: "system",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "Stable cached prefix" })]
      },
      {
        kind: "tools",
        zone: "prefix",
        content: catalog.definitions
      },
      {
        kind: "transcript",
        zone: "tail",
        content: [ModelRequest.Message.user("Load a value.")]
      }
    ],
    activeTools: Tools.initial(catalog).map((tool) => tool.name)
  })

const loaderCall = ModelRequest.Message.assistant(
  ModelRequest.ToolCallPart.make({
    id: "load-read",
    name: "search_tools",
    arguments: "{\"query\":\"read\"}"
  }),
  { stopReason: "tool-calls" }
)

const loadedRead = ModelRequest.ToolResultPart.make({
  toolCallId: "load-read",
  content: "read is available",
  addedToolNames: ["read"]
})

const loadedWrite = ModelRequest.ToolResultPart.make({
  toolCallId: "load-write",
  content: "write is available",
  addedToolNames: ["write"]
})

const requestFor = (context: ContextWindow.ContextWindow): ModelRequest.ModelRequest => ContextWindow.render(context)

const names = (definitions: ReadonlyArray<ModelRequest.ToolDefinition>): ReadonlyArray<string> =>
  definitions.map((definition) => definition.name)

const stablePrefix = (request: ModelRequest.ModelRequest): string =>
  JSON.stringify({
    modelId: request.modelId,
    system: request.system,
    messages: request.messages,
    params: request.params
  })

describe("Deferred tool cache parity", () => {
  // DeferredActivation.test.ts covers the single loader-to-next-request integration path;
  // these cases pin repeated activation, retention, cache identity, and replay.
  it("keeps activation strictly additive across successive requests", () => {
    const first = initialContext()
    const afterRead = ContextWindow.appendTurn(first, loaderCall, [loadedRead])
    const afterWrite = ContextWindow.appendTurn(afterRead, loaderCall, [loadedWrite])
    const firstRequest = requestFor(first)
    const secondRequest = requestFor(ContextWindow.activateTools(afterRead, ["read"]))
    const thirdRequest = requestFor(ContextWindow.activateTools(afterWrite, ["write"]))

    expect(DeferredTools.resolve(firstRequest, false).activatedNames).toEqual([])
    expect(DeferredTools.resolve(secondRequest, false).activatedNames).toEqual(["read"])
    expect(DeferredTools.resolve(thirdRequest, false).activatedNames).toEqual(["read", "write"])
    expect(names(DeferredTools.resolve(thirdRequest, false).immediate)).toEqual(["search_tools", "read", "write"])
  })

  it("keeps the loader available for the whole session", () => {
    const first = initialContext()
    const afterRead = ContextWindow.activateTools(
      ContextWindow.appendTurn(first, loaderCall, [loadedRead]),
      ["read"]
    )
    const afterWrite = ContextWindow.activateTools(
      ContextWindow.appendTurn(afterRead, loaderCall, [loadedWrite]),
      ["write"]
    )

    for (const request of [requestFor(first), requestFor(afterRead), requestFor(afterWrite)]) {
      expect(request.tools.some((tool) => tool.name === "search_tools")).toBe(true)
      expect(DeferredTools.resolve(request, false).immediate.some((tool) => tool.name === "search_tools")).toBe(true)
    }
  })

  it("preserves the sealed request prefix when lazy activation changes", () => {
    const before = requestFor(initialContext())
    const activated = requestFor(ContextWindow.activateTools(initialContext(), ["read", "write"]))

    expect(stablePrefix(activated)).toBe(stablePrefix(before))
    expect(JSON.stringify(before.system)).toBe(JSON.stringify(activated.system))
    expect(JSON.stringify(before.messages)).toBe(JSON.stringify(activated.messages))
    expect(DeferredTools.resolve(before, true).deferred.map((tool) => tool.name)).toEqual(["read", "write"])
  })

  it("replays the same activation set from the recorded message journal", () => {
    const journalMessages: ReadonlyArray<ModelRequest.Message> = Object.freeze([
      ModelRequest.Message.user("Load a value."),
      loaderCall,
      ModelRequest.Message.tool([loadedRead, loadedWrite])
    ])
    const journalRequest = ModelRequest.ModelRequest.make({
      modelId: "gpt-5.4",
      system: [ModelRequest.SystemPart.make({ text: "Stable cached prefix" })],
      messages: journalMessages,
      tools: catalog.definitions,
      params: ModelRequest.GenerationParams.make()
    })
    const replayed = DeferredTools.resolve(journalRequest, false)
    const rerun = DeferredTools.resolve(journalRequest, false)

    expect(replayed.activatedNames).toEqual(["read", "write"])
    expect(rerun.activatedNames).toEqual(replayed.activatedNames)
    expect(names(rerun.immediate)).toEqual(names(replayed.immediate))
  })
})
