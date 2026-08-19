import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Filegroup from "../src/Filegroup.ts"
import * as Target from "../src/Target.ts"
import * as Visibility from "../src/Visibility.ts"

/**
 * A visibility declaration is inert data an author writes in a BUILD.ts file.
 * Nothing enforces it yet, so every assertion here is about the declaration
 * itself: that it constructs, that it validates what it is given, that it
 * cannot be mutated after the fact, and that it never becomes key material.
 */
describe("visibility shorthands", () => {
  it("constructs every shorthand as a frozen, tagged, plain object", () => {
    const shorthands = [
      Visibility.private,
      Visibility.package,
      Visibility.subpackages,
      Visibility.public
    ]

    expect(shorthands.map((value) => value._tag)).toEqual(["Private", "Package", "Subpackages", "Public"])
    for (const value of shorthands) {
      expect(Object.isFrozen(value)).toBe(true)
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
      expect(Object.getOwnPropertySymbols(value)).toEqual([])
      expect(Visibility.isVisibility(value)).toBe(true)
    }
  })

  it("refuses a write to a declaration", () => {
    const declaration = Visibility.of("//packages/flow") as { labels: ReadonlyArray<string> }

    expect(() => {
      declaration.labels = []
    }).toThrow(TypeError)
    expect(declaration.labels).toEqual(["//packages/flow"])
  })

  it("freezes the label list a declaration carries", () => {
    const declaration = Visibility.of("//packages/flow")

    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Object.isFrozen(declaration.labels)).toBe(true)
  })
})

describe("Visibility.of", () => {
  it("accepts the workspace-anchored label forms", () => {
    const declaration = Visibility.of("//packages/flow", "//packages/plan:lib", "//packages/build/...", "//...")

    expect(declaration).toEqual({
      _tag: "Labels",
      labels: ["//packages/flow", "//packages/plan:lib", "//packages/build/...", "//..."]
    })
  })

  it("accepts a label in the workspace root package", () => {
    expect(Visibility.of("//", "//:root").labels).toEqual(["//", "//:root"])
  })

  it("deduplicates labels and keeps declaration order", () => {
    expect(Visibility.of("//b", "//a", "//b").labels).toEqual(["//b", "//a"])
  })

  it("names the label and the reason when a label is not a label", () => {
    expect(() => Visibility.of("packages/flow")).toThrow(/"packages\/flow" does not start with \/\//)
    expect(() => Visibility.of(":lib")).toThrow(/does not start with \/\//)
    expect(() => Visibility.of("//packages/../flow")).toThrow(/has the path segment "\.\."/)
    expect(() => Visibility.of("//packages//flow")).toThrow(/has an empty path segment/)
    expect(() => Visibility.of("//packages/flow:")).toThrow(/names an empty target/)
    expect(() => Visibility.of("//packages/flow:a:b")).toThrow(/carries more than one colon/)
    expect(() => Visibility.of("//packages/...:lib")).toThrow(/has the path segment "\.\.\."/)
    expect(() => Visibility.of("//packages\\flow")).toThrow(/uses a backslash separator/)
    expect(() => Visibility.of("//packages/\0flow")).toThrow(/contains a null byte/)
    expect(() => Visibility.of("//packages/\uD800")).toThrow(/is not well-formed UTF-16/)
    expect(() => Visibility.of("")).toThrow(/is empty/)
    expect(() => Visibility.of()).toThrow(/requires at least one label/)
    expect(() => Visibility.of(7 as never)).toThrow(TypeError)
  })
})

describe("Visibility.group", () => {
  it("stores a manifest predicate without calling it", () => {
    let called = false
    const declaration = Visibility.group({
      where: (manifest) => {
        called = true
        return manifest.smthrs.group === "engine"
      }
    })

    expect(declaration._tag).toBe("Group")
    expect(called).toBe(false)
    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Visibility.isVisibility(declaration)).toBe(true)
    expect(
      declaration.where({
        directory: "packages/engine",
        name: "@smthrs/engine",
        version: "0.1.0",
        smthrs: { group: "engine" }
      })
    ).toBe(true)
    expect(
      declaration.where({
        directory: "packages/targets",
        name: undefined,
        version: undefined,
        smthrs: { group: "tooling" }
      })
    ).toBe(false)
  })

  it("refuses a Proxy without invoking its traps, the way Target.make refuses one", () => {
    let invoked = false
    const proxy = new Proxy({ where: () => true }, {
      get: () => {
        invoked = true
        return undefined
      },
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })

    expect(() => Visibility.group(proxy)).toThrow(TypeError)
    expect(invoked).toBe(false)
  })

  it("refuses a non-plain prototype and a symbol-keyed options object", () => {
    class Options {
      readonly where = (): boolean => true
    }

    expect(() => Visibility.group(new Options())).toThrow(/plain object/)
    expect(() => Visibility.group(Object.assign({ where: () => true }, { [Symbol("tag")]: 1 }))).toThrow(/plain object/)
    expect(() => Visibility.group({ where: "everyone" } as never)).toThrow(/predicate function/)
    expect(() => Visibility.group(undefined as never)).toThrow(/plain object/)
  })

  it("refuses an options object whose `where` is an accessor, without running it", () => {
    let invoked = false
    const options = {}
    Object.defineProperty(options, "where", {
      configurable: true,
      enumerable: true,
      get: () => {
        invoked = true
        return () => true
      }
    })

    expect(() => Visibility.group(options as never)).toThrow(/predicate function/)
    expect(invoked).toBe(false)
  })
})

describe("Visibility.isVisibility", () => {
  it("rejects a forged declaration", () => {
    expect(Visibility.isVisibility({ _tag: "Everyone" })).toBe(false)
    expect(Visibility.isVisibility({ _tag: "Labels", labels: ["not-a-label"] })).toBe(false)
    expect(Visibility.isVisibility({ _tag: "Labels", labels: [7] })).toBe(false)
    expect(Visibility.isVisibility({ _tag: "Labels", labels: "//packages/flow" })).toBe(false)
    expect(Visibility.isVisibility({ _tag: "Group", where: "yes" })).toBe(false)
    expect(Visibility.isVisibility(Object.create({ _tag: "Public" }))).toBe(false)
    expect(Visibility.isVisibility(null)).toBe(false)
    expect(Visibility.isVisibility("public")).toBe(false)
  })

  it("rejects a Proxy without invoking its traps", () => {
    let invoked = false
    const proxy = new Proxy({ _tag: "Public" }, {
      get: () => {
        invoked = true
        return "Public"
      }
    })

    expect(Visibility.isVisibility(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })
})

const Attrs = Schema.Struct({ note: Schema.String })

const Plain = Target.make("VisibilityTestPlain", {
  attrs: Attrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("VisibilityTestPlain")
})

const Declared = Target.make("VisibilityTestDeclared", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  visibility: Visibility.of("//packages/flow"),
  sandbox: true,
  implementation: () => Target.notImplemented("VisibilityTestDeclared")
})

const PerVerb = Target.make("VisibilityTestPerVerb", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  attrsForKind: (kind, attrs) => kind === "lint" ? { ...attrs, note: "lint" } : attrs,
  visibility: (attrs) => attrs.note === "lint" ? Visibility.public : Visibility.subpackages,
  sandbox: (attrs) => attrs.note === "lint",
  implementation: () => Target.notImplemented("VisibilityTestPerVerb")
})

describe("target metadata carries visibility and sandbox", () => {
  it("defaults to private and unsandboxed", () => {
    const metadata = Target.metadata(Plain({ note: "a" }))

    expect(metadata.visibility).toEqual(Visibility.private)
    expect(metadata.sandbox).toBe(false)
  })

  it("carries a declared visibility and sandbox mode", () => {
    const metadata = Target.metadata(Declared({ note: "a" }))

    expect(metadata.visibility).toEqual({ _tag: "Labels", labels: ["//packages/flow"] })
    expect(metadata.sandbox).toBe(true)
  })

  it("keeps the declaration out of the attrs struct", () => {
    const metadata = Target.metadata(Declared({ note: "a" }))

    expect(metadata.attrs).toEqual({ note: "a" })
    expect(Object.keys(metadata.attrs as object)).toEqual(["note"])
  })

  it("passes the metadata guard, and fails it when either field is malformed", () => {
    const target = Declared({ note: "a" })
    expect(Target.isTarget(target)).toBe(true)

    const metadata = Target.metadata(target)
    const forge = (overrides: Record<string, unknown>): unknown => {
      const marker = (): void => undefined
      Object.defineProperty(marker, Target.TargetTypeId, {
        configurable: false,
        enumerable: false,
        value: { ...metadata, ...overrides },
        writable: false
      })
      return marker
    }

    expect(Target.isTarget(forge({}))).toBe(true)
    expect(Target.isTarget(forge({ visibility: undefined }))).toBe(false)
    expect(Target.isTarget(forge({ visibility: "public" }))).toBe(false)
    expect(Target.isTarget(forge({ visibility: { _tag: "Labels", labels: ["nope"] } }))).toBe(false)
    expect(Target.isTarget(forge({ sandbox: undefined }))).toBe(false)
    expect(Target.isTarget(forge({ sandbox: "yes" }))).toBe(false)
  })

  it("re-derives both per verb, alongside cacheability and outputs", () => {
    const metadata = Target.metadata(PerVerb({ note: "build" }))

    expect(metadata.visibility).toEqual(Visibility.subpackages)
    expect(metadata.sandbox).toBe(false)

    const build = metadata.forKind("build")
    expect(build.visibility).toEqual(Visibility.subpackages)
    expect(build.sandbox).toBe(false)

    const lint = metadata.forKind("lint")
    expect(lint.attrs).toEqual({ note: "lint" })
    expect(lint.visibility).toEqual(Visibility.public)
    expect(lint.sandbox).toBe(true)
  })

  it("refuses a declaration that is not a visibility declaration", () => {
    const Bad = Target.make("VisibilityTestBad", {
      attrs: Attrs,
      kinds: ["build"],
      visibility: { _tag: "Everyone" } as never,
      implementation: () => Target.notImplemented("VisibilityTestBad")
    })

    expect(() => Bad({ note: "a" })).toThrow(/not a visibility declaration/)
  })

  it("declares Filegroup public", () => {
    expect(Target.metadata(Filegroup.Filegroup({ srcs: [] })).visibility).toEqual(Visibility.public)
  })
})

/**
 * The planner keys a target on its target id, its implementation digest, its
 * schema identity, its declared outputs, and its canonicalized attrs. Two
 * targets that differ only in visibility or sandbox mode must therefore agree
 * on every one of those, or declaring a policy would evict a cached result.
 * `keyPreview` itself lives in `@smthrs/build-cli`, which this package does not
 * depend on; the CLI-level check is `build --plan --json`.
 */
describe("visibility and sandbox are not key material", () => {
  const Base = {
    attrs: Attrs,
    kinds: ["build"] as const,
    implementation: () => Target.notImplemented("VisibilityTestKeyed")
  }
  const Open = Target.make("VisibilityTestKeyed", { ...Base, visibility: Visibility.public, sandbox: true })
  const Closed = Target.make("VisibilityTestKeyed", { ...Base, visibility: Visibility.private, sandbox: false })

  it("produces identical key material for declarations that differ only in policy", () => {
    const open = Target.metadata(Open({ note: "a" }))
    const closed = Target.metadata(Closed({ note: "a" }))

    expect(open.visibility).not.toEqual(closed.visibility)
    expect(open.sandbox).not.toEqual(closed.sandbox)

    expect(open.target).toBe(closed.target)
    expect(open.implementationDigest).toBe(closed.implementationDigest)
    expect(open.schemaIdentity).toEqual(closed.schemaIdentity)
    expect(open.attrs).toEqual(closed.attrs)
    expect(open.outputs).toEqual(closed.outputs)
    expect(open.inputs).toEqual(closed.inputs)
    expect(open.dependencies).toEqual(closed.dependencies)
  })
})
