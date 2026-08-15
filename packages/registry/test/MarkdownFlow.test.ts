import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"

const provenance = new Descriptor.Provenance({ source: "test", root: "/flows" })

const fromMarkdown = (text: string, overrides: Partial<MarkdownFlow.FromMarkdownOptions> = {}) =>
  MarkdownFlow.fromMarkdown({
    text,
    path: "/flows/review/SKILL.md",
    baseDirectory: "/flows/review",
    naming: "frontmatter",
    name: Option.some("review"),
    dirBasename: "review",
    provenance,
    ...overrides
  })

describe("MarkdownFlow", () => {
  it("loads a minimal SKILL.md descriptor", () => {
    const result = fromMarkdown("---\nname: review\ndescription: Review a pull request\n---\nUse the available tools.")
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor).toMatchObject({
      name: "review",
      description: "Review a pull request",
      body: { _tag: "Markdown", path: "/flows/review/SKILL.md" },
      input: { _tag: "MarkdownArgs" },
      output: { _tag: "MarkdownOutput" },
      flows: [],
      capabilities: ["*"],
      effects: {
        reads: ["**"],
        writes: ["**"],
        mode: "expected",
        onConflict: "serialize",
        tier: "irreversible"
      },
      modelInvocable: true,
      frontmatter: { name: "review", description: "Review a pull request" }
    })
    expect(Option.isNone(descriptor.placement)).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "unprojectable_authority" }))
  })

  it("retains unmodified agentskills.io-shaped frontmatter", () => {
    const result = fromMarkdown(
      [
        "---",
        "name: review-pr",
        "description: Review a pull request",
        "license: 2.0",
        "allowed-tools: Read Bash",
        "metadata:",
        "  author: Example",
        "  version: 1.0",
        "---",
        "Review the pull request."
      ].join("\n"),
      {
        path: "/flows/review-pr/SKILL.md",
        dirBasename: "review-pr"
      }
    )
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.name).toBe("review-pr")
    expect(descriptor.flows).toEqual(["Read", "Bash"])
    expect(descriptor.capabilities).toEqual(["*"])
    expect(descriptor.frontmatter).toEqual({
      name: "review-pr",
      description: "Review a pull request",
      license: "2.0",
      "allowed-tools": "Read Bash",
      metadata: { author: "Example", version: "1.0" }
    })
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "unprojectable_authority" }))
  })

  it("drops only entries with a missing description", () => {
    const result = fromMarkdown("---\nname: review\ndescription: '   '\n---\nbody")

    expect(result.descriptor).toEqual(Option.none())
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "missing_description" }))
  })

  it("uses path names and warns when path-regime frontmatter declares a name", () => {
    const result = fromMarkdown("---\nname: ignored\ndescription: Review\n---\nbody", {
      naming: "path",
      name: Option.some("review/read-pr")
    })
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.name).toBe("review/read-pr")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "name_field_ignored" }))
  })

  it("warns and falls back to the directory name for frontmatter-regime entries without names", () => {
    const result = fromMarkdown("---\ndescription: Review\n---\nbody")
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.name).toBe("review")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "missing_name" }))
  })

  it("keeps agentskills allowed-tools as preapproved tool metadata", () => {
    const result = fromMarkdown(
      "---\nname: review\ndescription: Review\nallowed-tools: Bash(git:*) Bash(jq:*) Read\n---\nbody"
    )

    const descriptor = Option.getOrThrow(result.descriptor)
    expect(descriptor.flows).toEqual([
      "Bash(git:*)",
      "Bash(jq:*)",
      "Read"
    ])
    expect(descriptor.capabilities).toEqual(["*"])
    expect(descriptor.effects.tier).toBe("irreversible")
  })

  it("does not treat commas as allowed-tools separators", () => {
    const result = fromMarkdown(
      "---\nname: review\ndescription: Review\nallowed-tools: Read, Bash\n---\nbody"
    )

    expect(Option.getOrThrow(result.descriptor).flows).toEqual(["Read,", "Bash"])
  })

  it("hides disable-model-invocation entries only from model invocation", () => {
    const descriptor = Option.getOrThrow(
      fromMarkdown("---\ndescription: Review\ndisable-model-invocation: true\n---\nbody").descriptor
    )

    expect(descriptor.modelInvocable).toBe(false)
  })

  it("defaults invalid effect tiers to irreversible with a warning", () => {
    const result = fromMarkdown("---\ndescription: Review\neffects:\n  tier: dangerous\n---\nbody")
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.effects.tier).toBe("irreversible")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_effect_tier" }))
  })

  it("infers authority tiers only from explicit capabilities", () => {
    const read = fromMarkdown("---\ndescription: Read files\ncapabilities: [Read]\n---\nbody")
    const write = fromMarkdown("---\ndescription: Write files\ncapabilities: [Write]\n---\nbody")
    const edit = fromMarkdown("---\ndescription: Edit files\ncapabilities: [Edit]\n---\nbody")
    const unscopedWrite = fromMarkdown("---\ndescription: Write files\ncapabilities: [fs:write]\n---\nbody")
    const unknownWrite = fromMarkdown("---\ndescription: Write git state\ncapabilities: [git:write]\n---\nbody")
    const unknownRead = fromMarkdown("---\ndescription: Read unknown state\ncapabilities: [arbitrary:read]\n---\nbody")
    const escapingWrite = fromMarkdown(
      "---\ndescription: Write outside\ncapabilities: [fs:write:../outside]\n---\nbody"
    )
    const absoluteWrite = fromMarkdown(
      "---\ndescription: Write outside\ncapabilities: [fs:write:/tmp/out]\n---\nbody"
    )
    const workspaceWrite = fromMarkdown(
      "---\ndescription: Write source files\ncapabilities: [fs:write:src/**]\n---\nbody"
    )
    const shell = fromMarkdown("---\ndescription: Run a command\ncapabilities: [Bash(git:*)]\n---\nbody")

    expect(Option.getOrThrow(read.descriptor).effects.tier).toBe("sealed")
    expect(Option.getOrThrow(write.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(edit.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(unscopedWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(unknownWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(unknownRead.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(escapingWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(absoluteWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(workspaceWrite.descriptor).effects.tier).toBe("compensable")
    expect(Option.getOrThrow(shell.descriptor).effects.tier).toBe("irreversible")
  })

  it("warns with field-specific codes for malformed known frontmatter", () => {
    const result = fromMarkdown([
      "---",
      "name: review",
      `description: ${"a".repeat(1025)}`,
      "license:",
      "  - MIT",
      `compatibility: ${"b".repeat(501)}`,
      "metadata:",
      "  version:",
      "    nested: invalid",
      "allowed-tools:",
      "  command: bash",
      "disable-model-invocation: yes",
      "---",
      "body"
    ].join("\n"))

    expect(Option.isSome(result.descriptor)).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "invalid_description",
      "invalid_license",
      "invalid_compatibility",
      "invalid_metadata",
      "invalid_allowed_tools",
      "invalid_model_invocation"
    ]))
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "unknown_frontmatter_key" }))
  })

  it("keeps descriptors serializable when YAML aliases are cyclic", () => {
    const result = fromMarkdown([
      "---",
      "name: review",
      "description: Review",
      "capabilities: []",
      "metadata: &metadata",
      "  author: Example",
      "  self: *metadata",
      "---",
      "body"
    ].join("\n"))
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "non_serializable_frontmatter"
    }))
    expect(descriptor.frontmatter.metadata).toEqual({
      author: "Example",
      self: null
    })
    expect(() => JSON.stringify(descriptor)).not.toThrow()
  })

  it("strips frontmatter exactly when loading a body", () => {
    expect(MarkdownFlow.loadBody(
      "---\ndescription: Review\n---\nLine one\n\nLine two",
      "/flows/review"
    )).toEqual(
      new Descriptor.FlowBodyPrompt({
        text: "Line one\n\nLine two",
        baseDirectory: "/flows/review"
      })
    )
  })

  it("renders the resource base directory and appends arguments when present", () => {
    const body = new Descriptor.FlowBodyPrompt({
      text: "Review the pull request.",
      baseDirectory: "/flows/review"
    })

    const withoutArguments = MarkdownFlow.renderPrompt(body, { args: "" })
    const withArguments = MarkdownFlow.renderPrompt(body, { args: "4821" })

    expect(withoutArguments).toContain("Review the pull request.")
    expect(withoutArguments).toContain("- Base directory: /flows/review")
    expect(withArguments).toContain("- Base directory: /flows/review")
    expect(withArguments.endsWith("\n\n4821")).toBe(true)
  })
})
