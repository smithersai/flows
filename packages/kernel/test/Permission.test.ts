import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern } from "../src/Capability.ts"
import { evaluate, Rule } from "../src/Permission.ts"

const capability = new Capability({
  action: "fs:read",
  resource: "/workspace/readme.md"
})

const rule = (
  effect: "allow" | "deny" | "ask",
  action: "fs:read" | "fs:*" | "*",
  resource: string
): Rule =>
  new Rule({
    effect,
    pattern: new CapabilityPattern({ action, resource })
  })

describe("Permission policy", () => {
  it("uses the last matching rule across ordered rulesets", () => {
    expect(
      evaluate(
        [
          [
            rule("deny", "fs:read", "/tmp/**"),
            rule("ask", "fs:*", "/workspace/**")
          ],
          [rule("allow", "fs:read", "/workspace/**")],
          [rule("deny", "fs:read", "/workspace/private/**")]
        ],
        capability
      )
    ).toBe("allow")

    expect(
      evaluate(
        [
          [rule("ask", "fs:*", "/workspace/**")],
          [
            rule("allow", "fs:read", "/workspace/**"),
            rule("deny", "fs:read", "/workspace/readme.md")
          ]
        ],
        capability
      )
    ).toBe("deny")
  })

  it("reduces configured rules last-match-wins before applying deny precedence", () => {
    expect(
      evaluate(
        [
          [
            rule("deny", "fs:*", "/workspace/**"),
            rule("allow", "fs:read", "/workspace/readme.md")
          ],
          [],
          [],
          [rule("allow", "*", "**")]
        ],
        capability
      )
    ).toBe("allow")

    expect(
      evaluate(
        [
          [
            rule("allow", "fs:read", "/workspace/readme.md"),
            rule("deny", "fs:*", "/workspace/**")
          ],
          [rule("allow", "*", "**")]
        ],
        capability
      )
    ).toBe("deny")
  })

  it("defaults to ask when no rule matches", () => {
    expect(
      evaluate(
        [[rule("allow", "fs:read", "/other/**")]],
        capability
      )
    ).toBe("ask")
    expect(evaluate([], capability)).toBe("ask")
  })
})
