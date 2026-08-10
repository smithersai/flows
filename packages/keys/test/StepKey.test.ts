import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type * as CoreKeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import vectors from "./vectors.json" with { type: "json" }

type Vector = {
  readonly name: string
  readonly kind: "content" | "ordinal"
  readonly input: StepKey.ContentIdentity | StepKey.OrdinalIdentity
  readonly expected: string
}

describe("StepKey", () => {
  const get = <E>(result: Result.Result<StepKey.StepKey, E>): StepKey.StepKey => Result.getOrThrow(result)

  it.each(vectors as ReadonlyArray<Vector>)("validates committed $name vector", (vector) => {
    const actual = vector.kind === "content"
      ? get(StepKey.content(vector.input as StepKey.ContentIdentity))
      : get(StepKey.ordinal(vector.input as StepKey.OrdinalIdentity))
    expect(actual).toBe(vector.expected)
  })

  it("keeps reordered declarations equal and all material changes distinct", () => {
    const byName = new Map((vectors as ReadonlyArray<Vector>).map((vector) => [vector.name, vector.expected]))
    expect(byName.get("reordered declarations")).toBe(byName.get("reordered declarations equivalent"))
    // Renamed from "digest input": a plain `{ digest }` JSON literal can no
    // longer represent a real digest reference (StepKey.digestInput's brand
    // isn't JSON-representable), so this now pins that it hashes as a literal.
    expect(byName.get("literal input")).not.toBe(byName.get("digest-shaped literal"))
    expect(byName.get("hermetic bash")).not.toBe(byName.get("widened write set"))
    expect(byName.get("ordinary sealed")).not.toBe(byName.get("changed layer"))
    expect(byName.get("ordinary sealed")).not.toBe(byName.get("changed capability"))
  })

  it("validates the branded wire representation", () => {
    const valid = get(StepKey.content({ body: "x", inputs: {}, layers: [], capabilities: {} }))
    expect(Schema.decodeUnknownSync(StepKey.StepKey)(valid)).toBe(valid)
    expect(() => Schema.decodeUnknownSync(StepKey.StepKey)("sk1_not-a-digest")).toThrow()
  })

  it("normalizes duplicate Unicode set declarations and read-set ordering", () => {
    const base = {
      body: "x",
      inputs: {},
      capabilities: { "fs:read": ["é", "e\u0301"] },
      hermetic: {
        readSet: [
          { path: "b", digest: "2" },
          { path: "a", digest: "1" },
          { path: "a", digest: "1" },
          { path: "a", digest: "0" }
        ],
        writeSet: ["out", "out"],
        boundaryMode: "expected" as const
      }
    }
    expect(get(StepKey.content({ ...base, layers: ["e\u0301", "é"] }))).toBe(
      get(StepKey.content({
        ...base,
        layers: ["é"],
        capabilities: { "fs:read": ["é"] },
        hermetic: {
          ...base.hermetic,
          readSet: base.hermetic.readSet.filter((_, index) => index !== 2).reverse()
        }
      }))
    )
  })

  it("keeps engine environment material distinct from caller declarations", () => {
    const base: StepKey.ContentIdentity = {
      body: "x",
      inputs: {},
      layers: [],
      capabilities: {}
    }
    const callerOwned = get(StepKey.content({
      ...base,
      layers: ["model"],
      capabilities: { fs: ["/workspace"] },
      environment: { declared: true, layers: [], capabilities: {} }
    }))
    const engineOwned = get(StepKey.content({
      ...base,
      environment: {
        declared: true,
        layers: ["model"],
        capabilities: { fs: ["/workspace"] }
      }
    }))
    const undeclared = get(StepKey.content({
      ...base,
      environment: { declared: false, layers: [], capabilities: {}, runScope: "run-a" }
    }))
    const otherRun = get(StepKey.content({
      ...base,
      environment: { declared: false, layers: [], capabilities: {}, runScope: "run-b" }
    }))
    const ordered = get(StepKey.content({
      ...base,
      environment: { declared: true, layers: ["model", "host"], capabilities: {} }
    }))
    const reordered = get(StepKey.content({
      ...base,
      environment: { declared: true, layers: ["host", "model"], capabilities: {} }
    }))

    expect(callerOwned).not.toBe(engineOwned)
    expect(undeclared).not.toBe(otherRun)
    expect(ordered).not.toBe(reordered)
  })

  it("resolves dependency ids before hashing and includes resolved layers", () => {
    const material = (from: string, layers: ReadonlyArray<string>): CoreKeyMaterial.KeyMaterial => ({
      version: "flows/key-material/v1",
      kind: "sealed",
      body: { operation: "summarize" },
      inputs: [{ _tag: "Ref", from, path: [] }],
      layers,
      capabilities: ["model:call:provider/model"],
      effects: undefined,
      placement: undefined
    })
    const first = get(StepKey.fromKeyMaterial(material("root.all.named", ["host:v1"]), {
      "root.all.named": "dependency-digest"
    }))
    const renamed = get(StepKey.fromKeyMaterial(material("reordered.other", ["host:v1"]), {
      "reordered.other": "dependency-digest"
    }))

    expect(first).toBe(renamed)
    expect(first).not.toBe(
      get(StepKey.fromKeyMaterial(material("root.all.named", ["host:v2"]), {
        "root.all.named": "dependency-digest"
      }))
    )
  })

  it("returns typed failures for non-content material and missing dependencies", () => {
    const base: CoreKeyMaterial.KeyMaterial = {
      version: "flows/key-material/v1",
      kind: "sealed",
      body: { operation: "test" },
      inputs: [{ _tag: "Ref", from: "missing", path: [] }],
      layers: [],
      capabilities: [],
      effects: undefined,
      placement: undefined
    }
    const missing = StepKey.fromKeyMaterial(base, {})
    const nonContent = StepKey.fromKeyMaterial({ ...base, kind: "compensable" }, {})

    expect(
      Result.isFailure(missing) && missing.failure._tag === "@smthrs/keys/KeyMaterialError" && missing.failure.code
    )
      .toBe("missing_dependency")
    expect(
      Result.isFailure(nonContent) && nonContent.failure._tag === "@smthrs/keys/KeyMaterialError" &&
        nonContent.failure.code
    ).toBe("non_content_material")
  })

  it("distinguishes literal, pending, and projected dependency inputs", () => {
    const base: CoreKeyMaterial.KeyMaterial = {
      version: "flows/key-material/v1",
      kind: "sealed",
      body: { operation: "test" },
      inputs: [],
      layers: [],
      capabilities: [],
      effects: undefined,
      placement: undefined
    }
    const digest = { dependency: "digest" }
    const literal = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Literal", value: "digest" }]
    }, digest))
    const pending = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Pending", from: "dependency" }]
    }, digest))
    const projected = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Ref", from: "dependency", path: ["field"] }]
    }, digest))
    const bounded = get(StepKey.fromKeyMaterial({
      ...base,
      effects: { writes: ["/workspace"] },
      placement: { kind: "client" }
    }, digest))

    expect(new Set([literal, pending, projected, bounded]).size).toBe(4)
  })

  it("gives all four graph-local input kinds carrying identical payloads distinct keys", () => {
    const base: CoreKeyMaterial.KeyMaterial = {
      version: "flows/key-material/v1",
      kind: "sealed",
      body: { operation: "test" },
      inputs: [],
      layers: [],
      capabilities: [],
      effects: undefined,
      placement: undefined
    }
    const digest = { dependency: "shared-digest" }
    const literal = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Literal", value: "shared-digest" }]
    }, digest))
    const pending = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Pending", from: "dependency" }]
    }, digest))
    const refEmptyPath = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Ref", from: "dependency", path: [] }]
    }, digest))
    const refProjected = get(StepKey.fromKeyMaterial({
      ...base,
      inputs: [{ _tag: "Ref", from: "dependency", path: ["field"] }]
    }, digest))

    expect(new Set([literal, pending, refEmptyPath, refProjected]).size).toBe(4)
  })

  it("distinguishes Pending{from} from Ref{from, path: []} even though both resolve the same dependency digest", () => {
    // Regression for the bazel-audit P0 #2 finding: both variants fell through
    // normalizeInputs's shape-sniffing to the same `{ digest }` shape.
    const material = (
      inputRef: CoreKeyMaterial.InputRef
    ): CoreKeyMaterial.KeyMaterial => ({
      version: "flows/key-material/v1",
      kind: "sealed",
      body: "op",
      inputs: [inputRef],
      layers: [],
      capabilities: [],
      effects: undefined,
      placement: undefined
    })
    const digests = { dependency: "same-digest" }
    const pending = get(StepKey.fromKeyMaterial(material({ _tag: "Pending", from: "dependency" }), digests))
    const refEmptyPath = get(
      StepKey.fromKeyMaterial(material({ _tag: "Ref", from: "dependency", path: [] }), digests)
    )

    expect(pending).not.toBe(refEmptyPath)
  })

  it("hashes a literal value that looks like a digest reference differently from a real digest input", () => {
    // Regression for the bazel-audit P0 #2 finding: a literal `{ digest: "abc" }`
    // value used to shape-sniff identically to `StepKey.digestInput("abc")`.
    const lookalikeLiteral = get(StepKey.content({
      body: "op",
      inputs: { value: { digest: "abc" } },
      layers: [],
      capabilities: {}
    }))
    const realDigest = get(StepKey.content({
      body: "op",
      inputs: { value: StepKey.digestInput("abc") },
      layers: [],
      capabilities: {}
    }))

    expect(lookalikeLiteral).not.toBe(realDigest)
  })

  it("recognizes only values produced by digestInput as digest references", () => {
    expect(StepKey.isDigestInput(StepKey.digestInput("abc"))).toBe(true)
    expect(StepKey.isDigestInput({ digest: "abc" })).toBe(false)
    expect(StepKey.isDigestInput(null)).toBe(false)
    expect(StepKey.isDigestInput("abc")).toBe(false)
  })

  it("changes the key when KeyMaterial.version changes, all else equal", () => {
    const base = {
      kind: "sealed",
      body: { operation: "test" },
      inputs: [],
      layers: [],
      capabilities: [],
      effects: undefined,
      placement: undefined
    } as const
    const v1 = get(StepKey.fromKeyMaterial({ ...base, version: "flows/key-material/v1" }, {}))
    // KeyMaterial.version is currently a single-literal type; simulate a future
    // version bump the same way an upstream producer migration would.
    const v2 = get(
      StepKey.fromKeyMaterial(
        { ...base, version: "flows/key-material/v2" } as unknown as CoreKeyMaterial.KeyMaterial,
        {}
      )
    )

    expect(v1).not.toBe(v2)
  })

  it("a changed dependency digest produces a new key even though the material is identical", () => {
    const material: CoreKeyMaterial.KeyMaterial = {
      version: "flows/key-material/v1",
      kind: "sealed",
      body: { operation: "test" },
      inputs: [{ _tag: "Ref", from: "dependency", path: ["field"] }],
      layers: ["host:v1"],
      capabilities: ["cap:a"],
      effects: { writes: ["/workspace"] },
      placement: { kind: "client" }
    }
    // Only the *resolved* dependency value changes; every other byte of key
    // material is held constant. Reuse of the cached result must be impossible.
    const before = get(StepKey.fromKeyMaterial(material, { dependency: "digest-a" }))
    const after = get(StepKey.fromKeyMaterial(material, { dependency: "digest-b" }))
    expect(before).not.toBe(after)

    // ...and a dependency that recomputes to the same digest keeps the identity,
    // which is what makes memoized reuse safe.
    expect(get(StepKey.fromKeyMaterial(material, { dependency: "digest-a" }))).toBe(before)
  })

  it("is deterministic: repeated calls with the same input produce the same key", () => {
    const material: CoreKeyMaterial.KeyMaterial = {
      version: "flows/key-material/v1",
      kind: "sealed",
      body: { operation: "test" },
      inputs: [{ _tag: "Ref", from: "dependency", path: ["field"] }],
      layers: ["host:v1"],
      capabilities: ["cap:a"],
      effects: { writes: ["/workspace"] },
      placement: { kind: "client" }
    }
    const digests = { dependency: "digest" }
    const first = get(StepKey.fromKeyMaterial(material, digests))
    const second = get(StepKey.fromKeyMaterial(material, digests))
    const third = get(StepKey.fromKeyMaterial(material, digests))

    expect(first).toBe(second)
    expect(second).toBe(third)
  })
})
