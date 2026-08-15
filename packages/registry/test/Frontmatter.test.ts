import { describe, expect, it } from "vitest"
import * as Frontmatter from "../src/internal/Frontmatter.ts"

describe("Frontmatter", () => {
  it("splits leading frontmatter from its body", () => {
    expect(Frontmatter.split("---\nname: review\n---\n# Review")).toEqual({
      frontmatter: "name: review\n",
      body: "# Review"
    })
  })

  it("keeps files without frontmatter unchanged", () => {
    expect(Frontmatter.split("# Review\n")).toEqual({ frontmatter: undefined, body: "# Review\n" })
  })

  it("accepts CRLF frontmatter and a UTF-8 BOM", () => {
    expect(Frontmatter.split("\uFEFF---\r\nname: review\r\n---\r\n# Review")).toEqual({
      frontmatter: "name: review\r\n",
      body: "# Review"
    })
  })

  it("supports empty frontmatter blocks", () => {
    expect(Frontmatter.split("---\n---\nbody")).toEqual({ frontmatter: "", body: "body" })
  })

  it("detects when a streamed metadata prefix is complete", () => {
    expect(Frontmatter.isMetadataComplete("---\ndescription: Review")).toBe(false)
    expect(Frontmatter.isMetadataComplete("---\ndescription: Review\n---\npartial body")).toBe(true)
    expect(Frontmatter.isMetadataComplete("# No frontmatter")).toBe(true)
  })

  it("parses YAML fields without validating unknown keys", () => {
    expect(Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: "---\ndescription: 'Review: a pull request'\nallowed-tools: [a, b]\nblock:\n  - one\n  - two\n---\nbody"
    })).toEqual({
      fields: {
        description: "Review: a pull request",
        "allowed-tools": ["a", "b"],
        block: ["one", "two"]
      },
      warnings: []
    })
  })

  it("uses failsafe scalar semantics compatible with skills-ref", () => {
    expect(Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: "---\nlicense: 2.0\nmetadata:\n  version: 1.0\n  enabled: true\n---\nbody"
    })).toEqual({
      fields: {
        license: "2.0",
        metadata: {
          version: "1.0",
          enabled: "true"
        }
      },
      warnings: []
    })
  })

  it("sanitizes cyclic YAML aliases into serializable metadata", () => {
    const result = Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: [
        "---",
        "description: Review",
        "metadata: &metadata",
        "  author: Example",
        "  self: *metadata",
        "---",
        "body"
      ].join("\n")
    })

    expect(result.fields).toEqual({
      description: "Review",
      metadata: {
        author: "Example",
        self: null
      }
    })
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "non_serializable_frontmatter"
    }))
    expect(() => JSON.stringify(result.fields)).not.toThrow()
  })

  it("returns one warning for malformed YAML", () => {
    const result = Frontmatter.parse({ path: "/skills/broken/SKILL.md", text: "---\nname: [\n---\nbody" })
    expect(result.fields).toEqual({})
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe("frontmatter_parse_error")
  })

  it("returns one warning for non-object YAML", () => {
    const result = Frontmatter.parse({ path: "/skills/broken/SKILL.md", text: "---\n- review\n---\nbody" })
    expect(result.fields).toEqual({})
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe("frontmatter_parse_error")
  })
})
