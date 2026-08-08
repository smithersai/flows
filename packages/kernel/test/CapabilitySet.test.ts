import { Effect } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern } from "../src/Capability.ts"
import * as CapabilitySets from "../src/CapabilitySet.ts"

const actions = [
  "fs:read",
  "fs:write",
  "net:get",
  "net:post",
  "proc:spawn",
  "jj:status",
  "jj:diff",
  "jj:snapshot",
  "jj:restore",
  "jj:workspace-add",
  "jj:workspace-forget"
] as const

const patternActions = [
  ...actions,
  "fs:*",
  "net:*",
  "proc:*",
  "jj:*",
  "*"
] as const

const patternResources = [
  "**",
  "src/**",
  "test/**",
  "*.ts",
  "src/*.ts",
  "src/?ain.ts",
  "/workspace/**",
  "*.example.com",
  "api.example.com",
  "git",
  "npm *",
  "jj"
] as const

const capabilityResources = [
  "src/index.ts",
  "src/main.ts",
  "test/CapabilitySet.test.ts",
  "README.md",
  "/workspace/file.txt",
  "api.example.com",
  "www.example.com",
  "git",
  "npm test",
  "jj"
] as const

const patternArbitrary = FastCheck
  .tuple(
    FastCheck.constantFrom(...patternActions),
    FastCheck.constantFrom(...patternResources)
  )
  .map(([action, resource]) => new CapabilityPattern({ action, resource }))

const capabilityArbitrary = FastCheck
  .tuple(
    FastCheck.constantFrom(...actions),
    FastCheck.constantFrom(...capabilityResources)
  )
  .map(([action, resource]) => new Capability({ action, resource }))

const unrestricted = Effect.runSync(CapabilitySets.current)

const setArbitrary = FastCheck
  .array(FastCheck.array(patternArbitrary, { maxLength: 5 }), { maxLength: 4 })
  .map((groups) =>
    groups.reduce(
      (set, group) => CapabilitySets.intersect(set, CapabilitySets.fromPatterns(group)),
      unrestricted
    )
  )

const check = <Ts extends [unknown, ...unknown[]]>(
  arbitraries: { [K in keyof Ts]: FastCheck.Arbitrary<Ts[K]> },
  predicate: (...values: Ts) => boolean
): void => {
  FastCheck.assert(
    FastCheck.property(...arbitraries, predicate),
    { numRuns: 200 }
  )
}

describe("CapabilitySet", () => {
  it("normalizes pattern and group ordering and removes duplicates", () => {
    const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
    const get = new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
    const left = CapabilitySets.fromPatterns([get, read, read])
    const right = CapabilitySets.fromPatterns([read, get])

    expect(CapabilitySets.equals(left, right)).toBe(true)
    expect(left.groups).toEqual([[read, get]])
    expect(CapabilitySets.intersect(left, right).groups).toHaveLength(1)
  })

  it("requires every group to match while each group is any-of", () => {
    const set = CapabilitySets.intersect(
      CapabilitySets.fromPatterns([
        new CapabilityPattern({ action: "fs:read", resource: "src/**" }),
        new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
      ]),
      CapabilitySets.fromPatterns([
        new CapabilityPattern({ action: "fs:*", resource: "src/**" })
      ])
    )

    expect(CapabilitySets.allows(
      set,
      new Capability({ action: "fs:read", resource: "src/index.ts" })
    )).toBe(true)
    expect(CapabilitySets.allows(
      set,
      new Capability({ action: "net:get", resource: "api.example.com" })
    )).toBe(false)
  })

  it("proves a declared requirement is contained by every intersected group", () => {
    const set = CapabilitySets.intersect(
      CapabilitySets.fromPatterns([new CapabilityPattern({ action: "fs:*", resource: "/workspace/**" })]),
      CapabilitySets.fromPatterns([new CapabilityPattern({ action: "fs:read", resource: "/workspace/src/**" })])
    )

    expect(CapabilitySets.allowsPattern(
      set,
      new CapabilityPattern({ action: "fs:read", resource: "/workspace/src/a.ts" })
    )).toBe(true)
    expect(CapabilitySets.allowsPattern(
      set,
      new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
    )).toBe(false)
  })

  it("intersect is commutative", () => {
    check([setArbitrary, setArbitrary], (left, right) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(left, right),
        CapabilitySets.intersect(right, left)
      ))
  })

  it("intersect is associative", () => {
    check([setArbitrary, setArbitrary, setArbitrary], (left, middle, right) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(CapabilitySets.intersect(left, middle), right),
        CapabilitySets.intersect(left, CapabilitySets.intersect(middle, right))
      ))
  })

  it("intersect is idempotent", () => {
    check([setArbitrary], (set) => CapabilitySets.equals(CapabilitySets.intersect(set, set), set))
  })

  it("unrestricted is the identity", () => {
    check([setArbitrary], (set) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(set, unrestricted),
        set
      ) &&
      CapabilitySets.equals(
        CapabilitySets.intersect(unrestricted, set),
        set
      ))
  })

  it("none is absorbing", () => {
    check([setArbitrary], (set) =>
      CapabilitySets.equals(
        CapabilitySets.intersect(set, CapabilitySets.none),
        CapabilitySets.none
      ) &&
      CapabilitySets.equals(
        CapabilitySets.intersect(CapabilitySets.none, set),
        CapabilitySets.none
      ))
  })

  it("intersection never admits a capability rejected by either operand", () => {
    check(
      [setArbitrary, setArbitrary, capabilityArbitrary],
      (left, right, capability) =>
        !CapabilitySets.allows(
          CapabilitySets.intersect(left, right),
          capability
        ) ||
        (
          CapabilitySets.allows(left, capability) &&
          CapabilitySets.allows(right, capability)
        )
    )
  })

  it("attenuate nesting only shrinks child authority", async () => {
    const parentPatterns = [
      new CapabilityPattern({ action: "fs:*", resource: "src/**" }),
      new CapabilityPattern({ action: "net:get", resource: "*.example.com" })
    ]
    const childPatterns = [
      new CapabilityPattern({ action: "fs:read", resource: "src/**" }),
      new CapabilityPattern({ action: "proc:spawn", resource: "**" })
    ]
    const capabilities = [
      new Capability({ action: "fs:read", resource: "src/index.ts" }),
      new Capability({ action: "fs:write", resource: "src/index.ts" }),
      new Capability({ action: "net:get", resource: "api.example.com" }),
      new Capability({ action: "proc:spawn", resource: "git" }),
      new Capability({ action: "fs:read", resource: "README.md" })
    ]

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* CapabilitySets.current
        const nested = yield* CapabilitySets.attenuate(parentPatterns)(
          Effect.gen(function*() {
            const parent = yield* CapabilitySets.current
            const child = yield* CapabilitySets.attenuate(childPatterns)(
              CapabilitySets.current
            )
            return { parent, child }
          })
        )
        const after = yield* CapabilitySets.current
        return { after, nested, root }
      })
    )

    expect(CapabilitySets.equals(result.root, unrestricted)).toBe(true)
    expect(CapabilitySets.equals(result.after, result.root)).toBe(true)
    expect(capabilities.every((capability) =>
      !CapabilitySets.allows(result.nested.child, capability) ||
      CapabilitySets.allows(result.nested.parent, capability)
    )).toBe(true)
    expect(CapabilitySets.allows(
      result.nested.child,
      new Capability({ action: "fs:read", resource: "src/index.ts" })
    )).toBe(true)
    expect(CapabilitySets.allows(
      result.nested.child,
      new Capability({ action: "net:get", resource: "api.example.com" })
    )).toBe(false)
  })

  it("exports no authority-widening API", () => {
    expect(Object.keys(CapabilitySets).sort()).toEqual([
      "allows",
      "allowsPattern",
      "attenuate",
      "current",
      "equals",
      "fromPatterns",
      "intersect",
      "none"
    ])
  })
})
