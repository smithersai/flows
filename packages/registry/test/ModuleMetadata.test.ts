import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import discoveredFlow from "./fixtures/project/flows/review/read-pr/flow.ts"

describe("ModuleMetadata", () => {
  it("reads metadata from the default Flow.make value without named schema exports", () => {
    const metadata = ModuleMetadata.parse([
      "\"use sandbox\"",
      "export default Flow.make({",
      "  description: \"Reviews a pull request.\",",
      "  input: Schema.Struct({ number: Schema.Number }),",
      "  output: Schema.Struct({ summary: Schema.String }),",
      "  capabilities: [\"fs:read:.\", \"net:get:api.github.com\"],",
      "  effects: Effects.make({",
      "    reads: [\".\"],",
      "    writes: [],",
      "    mode: \"hermetic\",",
      "    onConflict: \"serialize\",",
      "    tier: \"irreversible\"",
      "  }),",
      "  disableModelInvocation: true",
      "})"
    ].join("\n"))

    expect(metadata).toMatchObject({
      description: "Reviews a pull request.",
      hasInput: true,
      hasOutput: true,
      capabilities: ["fs:read:.", "net:get:api.github.com"],
      effects: {
        reads: ["."],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "irreversible"
      },
      modelInvocable: false,
      declaresName: false,
      warnings: []
    })
    expect(Option.getOrThrow(metadata.placement)).toBe("sandbox")
  })

  it("matches the real /core Flow.make effects contract", () => {
    expect(discoveredFlow.effects?.tier).toBe("irreversible")
    expect(
      ModuleMetadata.parse([
        "export default Flow.make({",
        "  description: \"Posts a result.\",",
        "  effects: {",
        "    reads: [],",
        "    writes: [],",
        "    mode: \"hermetic\",",
        "    onConflict: \"serialize\",",
        "    tier: \"irreversible\"",
        "  }",
        "})"
      ].join("\n")).effects.tier
    ).toBe("irreversible")
  })

  it("stops once the complete declaration is present", () => {
    expect(ModuleMetadata.isComplete("export default Flow.make({ description: \"Review\"")).toBe(false)
    expect(ModuleMetadata.isComplete("export default Flow.make({ description: \"Review\" })")).toBe(true)
  })

  it("ignores helper declarations and comments before the default export", () => {
    const source = [
      "// export default Flow.make({ description: \"Comment\", capabilities: [] })",
      "const helper = Flow.make({ description: \"Helper\", capabilities: [] })",
      "export default Flow.make({",
      "  description: \"Default\",",
      "  capabilities: [\"net:get\"]",
      "})"
    ].join("\n")

    expect(ModuleMetadata.isComplete(source.slice(0, source.indexOf("export default")))).toBe(false)
    expect(ModuleMetadata.parse(source)).toMatchObject({
      description: "Default",
      capabilities: ["net:get"],
      effects: { tier: "sealed" }
    })
  })

  it("does not treat braces in regular expressions as object syntax", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Validates a closing brace.\",",
      "  input: Schema.String.pipe(Schema.pattern(/}/)),",
      "  output: Schema.String,",
      "  capabilities: [\"net:post\"]",
      "})"
    ].join("\n"))

    expect(metadata).toMatchObject({
      description: "Validates a closing brace.",
      hasInput: true,
      hasOutput: true,
      capabilities: ["net:post"],
      effects: { tier: "irreversible" },
      warnings: []
    })
  })

  it("projects agent flow authority conservatively", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.agent({",
      "  description: \"Reviews a change.\",",
      "  flows: [readFile, writeFile]",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.warnings).toContainEqual({
      message: "Flow authority cannot be projected statically; using the conservative wildcard"
    })
  })

  it.each([
    ["an object spread", "...authority"],
    ["a computed property", "[authorityKey]: [\"net:post\"]"]
  ])("projects %s as conservative authority", (_label, member) => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Posts a message\",",
      `  ${member}`,
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.hasInput).toBe(true)
    expect(metadata.hasOutput).toBe(true)
    expect(metadata.warnings).toContainEqual({
      message:
        "Object spread or computed properties make schemas and authority unprojectable; using conservative projections"
    })
  })

  it("reads placement directives after leading comments", () => {
    const metadata = ModuleMetadata.parse([
      "/* generated header */",
      "// placement follows",
      "\"use remote\"",
      "export default Flow.make({ description: \"Runs remotely.\" })"
    ].join("\n"))

    expect(Option.getOrThrow(metadata.placement)).toBe("remote")
  })

  it("warns when authority metadata cannot be statically projected", () => {
    const metadata = ModuleMetadata.parse([
      "export default Flow.make({",
      "  description: \"Review\",",
      "  capabilities,",
      "  effects: {",
      "    reads: [],",
      "    writes: [],",
      "    mode: \"hermetic\",",
      "    onConflict: \"serialize\",",
      "    tier",
      "  }",
      "})"
    ].join("\n"))

    expect(metadata.capabilities).toEqual(["*"])
    expect(metadata.effects.tier).toBe("irreversible")
    expect(metadata.warnings.map((warning) => warning.message)).toEqual([
      "Capabilities must be a string-literal array for discovery; using the conservative wildcard",
      "Effects tier must be a sealed, compensable, or irreversible string literal; using irreversible"
    ])
  })
})
