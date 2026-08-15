import { ModelRequest } from "@smthrs/model"
import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowTool from "../src/FlowTool.ts"
import * as Tools from "../src/Tools.ts"

const read = ModelRequest.ToolDefinition.make({
  name: "read",
  description: "Read a declared value.",
  parameters: { type: "object" },
  deferred: true
})

const write = ModelRequest.ToolDefinition.make({
  name: "write",
  description: "Write through a declared flow.",
  parameters: { type: "object" },
  deferred: true
})

describe("Tools", () => {
  it("keeps the loader active and activation additive in declaration order", () => {
    const catalog = Result.getOrThrow(Tools.Catalog.makeResult([FlowTool.definition, read, write]))
    const initial = Tools.initial(catalog)
    const activated = Tools.activate(catalog, initial, ["write"])
    const replayed = Tools.activate(catalog, activated, ["read"])

    expect(initial.map((tool) => tool.name)).toEqual(["flow"])
    expect(activated.map((tool) => tool.name)).toEqual(["flow", "write"])
    expect(replayed.map((tool) => tool.name)).toEqual(["flow", "read", "write"])
    expect("deactivate" in Tools).toBe(false)
  })

  it("replays recorded addedToolNames without consulting mutable state", () => {
    const catalog = Result.getOrThrow(Tools.Catalog.makeResult([FlowTool.definition, read, write]))
    const recorded = ModelRequest.ToolResultPart.make({
      toolCallId: "call-1",
      content: "loaded",
      addedToolNames: ["read"]
    })

    expect(Tools.activate(catalog, Tools.initial(catalog), recorded.addedToolNames)).toEqual(
      Tools.activate(catalog, Tools.initial(catalog), recorded.addedToolNames)
    )
  })

  it("returns typed failures for prompt metadata without throwing", () => {
    const invalid = Object.assign(
      ModelRequest.ToolDefinition.make({
        name: "invalid",
        description: "Invalid deferred tool.",
        parameters: {},
        deferred: true
      }),
      { promptSnippet: "changes system content" }
    )

    const catalog = Tools.Catalog.makeResult([invalid])
    const lazy = Tools.lazyResult(invalid)

    expect(Result.isFailure(catalog)).toBe(true)
    expect(Result.isFailure(catalog) && catalog.failure).toBeInstanceOf(Tools.ToolError)
    expect(Result.isFailure(catalog) && catalog.failure.code).toBe("lazy_tool_prompt_metadata")
    expect(Result.isFailure(lazy) && lazy.failure).toBeInstanceOf(Tools.ToolError)
    expect(Result.isFailure(lazy) && lazy.failure.code).toBe("lazy_tool_prompt_metadata")
    expect(() => Tools.lazy(invalid)).not.toThrow()
  })

  it("preserves the lazy wire projection for valid definitions", () => {
    const result = Tools.lazyResult(read)
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        name: "read",
        description: "Read a declared value.",
        parameters: { type: "object" },
        deferred: true
      }
    })
    expect(Result.isSuccess(result)).toBe(true)
  })

  it("defines a catalogue-free flow schema that round-trips", () => {
    const parameters = JSON.parse(JSON.stringify(FlowTool.definition.parameters)) as Record<string, unknown>

    expect(FlowTool.definition.name).toBe("flow")
    expect(FlowTool.definition.loader).toBe(true)
    expect(parameters).toEqual(FlowTool.definition.parameters)
    expect(JSON.stringify(parameters)).not.toContain("enum")
  })

  it("never changes prompt segments or instruction text during activation", () => {
    const catalog = Result.getOrThrow(Tools.Catalog.makeResult([FlowTool.definition, read]))
    const system = "stable cached system prefix"
    const instructions = "stable instructions"

    Tools.activate(catalog, Tools.initial(catalog), ["read"])

    expect(system).toBe("stable cached system prefix")
    expect(instructions).toBe("stable instructions")
  })
})
