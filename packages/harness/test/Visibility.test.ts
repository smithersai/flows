import { Descriptor } from "@smthrs/registry"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Visibility from "../src/Visibility.ts"

const descriptor = (name: string): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: name,
    body: new Descriptor.BodyRefMarkdown({ path: `/flows/${name}/flow.mdx`, baseDirectory: `/flows/${name}` }),
    input: new Descriptor.SchemaRefNone({}),
    output: new Descriptor.SchemaRefNone({}),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}/flow.mdx`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const descriptors = [descriptor("read"), descriptor("read/private"), descriptor("write"), descriptor("docs")]

describe("Visibility", () => {
  it("fails closed for an empty ruleset", () => {
    expect(Visibility.filter(descriptors, Visibility.make({ name: "empty", ruleset: [] }))).toEqual([])
  })

  it("uses last-match precedence and supports glob patterns", () => {
    const seat = Visibility.make({
      name: "reviewer",
      ruleset: [
        new Visibility.Rule({ effect: "allow", pattern: "read/**" }),
        new Visibility.Rule({ effect: "deny", pattern: "read/private" }),
        new Visibility.Rule({ effect: "allow", pattern: "docs" })
      ]
    })
    expect(Visibility.filter(descriptors, seat).map(({ name }) => name)).toEqual(["docs"])
  })

  it("applies a deny after a broad allow", () => {
    const seat = Visibility.make({
      name: "safe",
      rules: [
        new Visibility.Rule({ effect: "allow", pattern: "**" }),
        new Visibility.Rule({ effect: "deny", pattern: "write*" })
      ]
    })
    expect(Visibility.filter(descriptors, seat).map(({ name }) => name)).toEqual([
      "read",
      "read/private",
      "docs"
    ])
  })
})
