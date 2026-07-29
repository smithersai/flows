import type * as CoreKeyMaterial from "@flows/core/KeyMaterial"
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
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
    expect(byName.get("literal input")).not.toBe(byName.get("digest input"))
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

    expect(Result.isFailure(missing) && missing.failure.code).toBe("missing_dependency")
    expect(Result.isFailure(nonContent) && nonContent.failure.code).toBe("non_content_material")
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
})
