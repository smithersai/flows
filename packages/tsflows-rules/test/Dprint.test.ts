import { describe, expect, it } from "vitest"
import { Dprint } from "../src/Dprint.ts"
import * as Input from "../src/Input.ts"
import * as Rule from "../src/Rule.ts"
import { StandardPackage } from "../src/StandardPackage.ts"

describe("Dprint", () => {
  it("declares a lint-kind, non-cacheable formatting check", () => {
    const target = Dprint({
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("dprint.json"),
      fix: false,
      cwd: "packages/example"
    })
    const metadata = Rule.metadata(target)
    expect(metadata.rule).toBe("Dprint")
    expect(metadata.kinds).toEqual(["lint"])
    expect(metadata.cacheable).toBe(false)
    expect(metadata.inputs).toHaveLength(2)
  })

  it("joins StandardPackage as the fmt target alongside check", () => {
    const targets = StandardPackage({ cwd: "packages/example" })
    expect(Rule.metadata(targets.fmt).rule).toBe("Dprint")
    expect(Rule.metadata(targets.fmt).kinds).toEqual(["lint"])
    expect(Rule.metadata(targets.check).rule).toBe("Typecheck")
    expect(Rule.metadata(targets.check).kinds).toEqual(["build"])
    // check resolves workspace dependencies through built declarations, so
    // it must schedule after the package's own lib target.
    expect(Rule.metadata(targets.check).dependencies).toContain(targets.lib)
  })
})
