import * as Node from "@smthrs/plan-next/Node"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Rule from "../src/Rule.ts"

const Leaf = Rule.make("RuleTestLeaf", {
  attrs: Schema.Struct({}),
  kinds: ["build"],
  implementation: () => Rule.notImplemented("RuleTestLeaf")
})

describe("Rule metadata traversal", () => {
  it("recognizes only an own, immutable, well-formed target marker", () => {
    const target = Leaf({})
    expect(Rule.isTarget(target)).toBe(true)

    let invoked = false
    const accessor = (): void => undefined
    Object.defineProperty(accessor, Rule.TargetTypeId, {
      configurable: false,
      enumerable: false,
      get: () => {
        invoked = true
        return Rule.metadata(target)
      }
    })
    expect(Rule.isTarget(accessor)).toBe(false)
    expect(invoked).toBe(false)

    const malformed = (): void => undefined
    Object.defineProperty(malformed, Rule.TargetTypeId, {
      configurable: false,
      enumerable: false,
      value: { rule: "forged" },
      writable: false
    })
    expect(Rule.isTarget(malformed)).toBe(false)
    expect(() => Rule.metadata(malformed as never)).toThrow(/not a well-formed tsflows target/)
  })

  it("rejects target proxies without invoking their traps", () => {
    let invoked = false
    const proxy = new Proxy(Leaf({}), {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      },
      has: () => {
        invoked = true
        return true
      }
    })
    expect(Rule.isTarget(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })

  it("defaults arbitrary rule implementations to non-cacheable", () => {
    expect(Rule.metadata(Leaf({})).cacheable).toBe(false)
  })

  it("requires a rule implementation to opt into cache replay explicitly", () => {
    const Deterministic = Rule.make("RuleTestDeterministic", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      cache: true,
      implementation: () => Rule.notImplemented("RuleTestDeterministic")
    })
    expect(Rule.metadata(Deterministic({})).cacheable).toBe(true)
  })

  it("re-derives dependencies from verb-effective attrs", () => {
    const declared = Leaf({})
    const mapped = Leaf({})
    const Parent = Rule.make("RuleTestMappedDependencies", {
      attrs: Schema.Struct({ dependency: Rule.Target }),
      kinds: ["build", "lint"],
      attrsForKind: (kind, attrs) => kind === "lint" ? { dependency: mapped } : attrs,
      implementation: () => Rule.notImplemented("RuleTestMappedDependencies")
    })

    const metadata = Rule.metadata(Parent({ dependency: declared }))
    expect(metadata.dependencies).toEqual([declared])
    expect(metadata.forKind("build").dependencies).toEqual([declared])
    expect(metadata.forKind("lint").dependencies).toEqual([mapped])
  })

  it("does not recurse forever through a cyclic array", () => {
    const cyclic: Array<unknown> = []
    cyclic.push(cyclic)
    const Holder = Rule.make("RuleTestCycle", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Rule.notImplemented("RuleTestCycle")
    })

    expect(() => Holder({ value: cyclic })).not.toThrow()
  })

  it("refuses a Proxy without executing its traversal traps", () => {
    let invoked = false
    const proxy = new Proxy({}, {
      ownKeys: () => {
        invoked = true
        return []
      }
    })
    const Holder = Rule.make("RuleTestProxy", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Rule.notImplemented("RuleTestProxy")
    })

    expect(() => Holder({ value: proxy })).toThrow(/must not contain a Proxy/)
    expect(invoked).toBe(false)
  })

  it("changes implementation identity when a runtime contract changes", () => {
    const implementation = () => Rule.notImplemented("RuleTestSchemaIdentity")
    const StringResult = Rule.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.String,
      error: Schema.String,
      implementation
    })
    const NumberResult = Rule.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.Number,
      error: Schema.String,
      implementation
    })

    expect(Rule.metadata(StringResult({ value: "x" })).implementationDigest)
      .not.toBe(Rule.metadata(NumberResult({ value: "x" })).implementationDigest)
  })

  it("changes implementation identity when cache admission policy changes", () => {
    const definition = (cache: boolean) =>
      Rule.make("RuleTestCacheIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        cache,
        implementation: () => Rule.notImplemented("RuleTestCacheIdentity")
      })
    expect(Rule.metadata(definition(false)({})).implementationDigest)
      .not.toBe(Rule.metadata(definition(true)({})).implementationDigest)
  })

  it("changes implementation identity when declared captures change", () => {
    const definition = (tool: string) =>
      Rule.make("RuleTestCapturedIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        implementation: Node.capture({ tool }, () => Rule.notImplemented(tool))
      })

    expect(Rule.metadata(definition("first")({})).implementationDigest)
      .not.toBe(Rule.metadata(definition("second")({})).implementationDigest)
  })
})
