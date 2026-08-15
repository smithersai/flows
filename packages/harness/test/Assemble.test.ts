import { ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Assemble from "../src/Assemble.ts"
import * as Visibility from "../src/Visibility.ts"
import { journal } from "./fixtures/journal.ts"

const visible = [
  new Descriptor.FlowDescriptor({
    name: "read",
    description: "Read a file",
    body: new Descriptor.BodyRefMarkdown({
      path: "/flows/read/flow.mdx",
      baseDirectory: "/flows/read"
    }),
    input: new Descriptor.SchemaRefNone({}),
    output: new Descriptor.SchemaRefNone({}),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    modelInvocable: true,
    path: "/flows/read/flow.mdx",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })
]

describe("Assemble", () => {
  it("is deterministic and only exposes registry names and descriptions", () => {
    const input: Assemble.Input = {
      journal: journal(),
      system: { text: "system", digest: "system-digest" },
      instructions: [{ text: "root", digest: "root-digest" }],
      prompt: { text: "prompt", digest: "prompt-digest" },
      modelId: "model",
      params: ModelRequest.GenerationParams.make(),
      flowInput: { value: "input" },
      activeToolNames: ["flow"],
      toolDefinitions: [
        ModelRequest.ToolDefinition.make({ name: "flow", description: "Run a flow", parameters: {} })
      ],
      registry: visible,
      seat: Visibility.make({ name: "reviewer", ruleset: [new Visibility.Rule({ effect: "allow", pattern: "*" })] })
    }
    const first = Assemble.assemble(input)
    const second = Assemble.assemble(input)
    expect(first.segments).toEqual(second.segments)
    expect(first.digest).toBe(second.digest)
    expect(first.tokens).toEqual(second.tokens)
    const registrySegment = first.segments.find((segment) => segment.kind === "registry")
    expect(registrySegment?.content[0]).toMatchObject({ text: expect.stringContaining("<name>read</name>") })
    expect(registrySegment?.content[0]).toMatchObject({
      text: expect.stringContaining("<description>Read a file</description>")
    })
    const promptText = first.segments
      .slice(0, 7)
      .flatMap((segment) => segment.content)
      .map((part) => "text" in part ? part.text : "")
      .join("\n")
    expect(promptText.indexOf("You are a flows agent")).toBeLessThan(promptText.indexOf("You have two verbs"))
    expect(promptText.indexOf("You have two verbs")).toBeLessThan(promptText.indexOf("This run's envelope"))
    expect(promptText.indexOf("This run's envelope")).toBeLessThan(promptText.indexOf("<available_skills>"))
    expect(promptText.indexOf("<available_skills>")).toBeLessThan(promptText.indexOf("Recorded environment baseline"))
    expect(promptText.indexOf("Recorded environment baseline")).toBeLessThan(
      promptText.indexOf("Self-documentation is available")
    )
    expect(promptText.indexOf("Self-documentation is available")).toBeLessThan(
      promptText.indexOf("Project context is root-first")
    )
    expect(first.segments.slice(0, 7).every((segment) => segment.digest.length > 0)).toBe(true)
  })

  it("gates teaching disclosures and filters active flows per seat", () => {
    const input: Assemble.Input = {
      journal: [],
      system: { text: "envelope", digest: "envelope-digest" },
      instructions: [],
      prompt: { text: "prompt", digest: "prompt-digest" },
      modelId: "model",
      params: ModelRequest.GenerationParams.make(),
      flowInput: {},
      activeToolNames: ["read", "write"],
      toolDefinitions: [
        ModelRequest.ToolDefinition.make({ name: "flow", description: "Run a flow", parameters: {} })
      ],
      registry: visible,
      seat: Visibility.make({ name: "read-only", ruleset: [] })
    }
    const assembled = Assemble.assemble(input)
    const registry = assembled.segments.find((segment) => segment.kind === "registry")
    expect(registry?.content[0]).toMatchObject({ text: "" })
    expect(assembled.activeTools).toEqual([])
    expect(assembled.segments[5]?.content[0]).toMatchObject({ text: "" })
  })

  it("assembles advisory source text into the declared instruction prefix", () => {
    const assembled = Assemble.assemble({
      journal: [],
      system: { text: "system", digest: "system" },
      instructions: [],
      sources: [{
        text: "<flows_memory_context>remember this</flows_memory_context>",
        digest: "memory"
      }],
      prompt: { text: "prompt", digest: "prompt" },
      modelId: "model",
      params: ModelRequest.GenerationParams.make(),
      flowInput: {},
      activeToolNames: [],
      toolDefinitions: [],
      registry: []
    })
    const text = assembled.segments
      .flatMap((segment) => segment.content)
      .map((part) => "text" in part ? part.text : "")
      .join("\n")
    expect(text).toContain("<flows_memory_context>remember this</flows_memory_context>")
  })
})
