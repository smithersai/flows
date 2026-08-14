import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import { runFailure, runPromise } from "./Crypto.ts"

const material = (overrides: Partial<KeyMaterial.KeyMaterial> = {}): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body: { action: "render" },
  inputs: [],
  layers: [],
  capabilities: [],
  ...overrides
})

describe("StepKey", () => {
  it("produces a key1_ digest and is stable under set reordering", async () => {
    const left = await runPromise(
      StepKey.content({ body: 1, inputs: {}, layers: ["b", "a"], capabilities: { fs: ["w", "r", "r"] } })
    )
    const right = await runPromise(
      StepKey.content({ body: 1, inputs: {}, layers: ["a", "b"], capabilities: { fs: ["r", "w"] } })
    )
    expect(left).toMatch(/^key1_[0-9a-f]{64}$/)
    expect(left).toBe(right)
  })

  it("hashes a branded digest input differently from a literal of the same shape", async () => {
    const branded = await runPromise(
      StepKey.content({ body: 1, inputs: { a: StepKey.digestInput("abc") }, layers: [], capabilities: {} })
    )
    const literal = await runPromise(
      StepKey.content({ body: 1, inputs: { a: { digest: "abc" } }, layers: [], capabilities: {} })
    )
    expect(StepKey.isDigestInput(StepKey.digestInput("abc"))).toBe(true)
    expect(StepKey.isDigestInput({ digest: "abc" })).toBe(false)
    expect(StepKey.isDigestInput(null)).toBe(false)
    expect(branded).not.toBe(literal)
  })

  it("keeps the environment namespace non-aliasing and order-sensitive", async () => {
    const separate = await runPromise(StepKey.content({
      body: 1,
      inputs: {},
      layers: ["a"],
      capabilities: {},
      environment: { declared: true, layers: ["b"], capabilities: { fs: ["r"] } }
    }))
    const merged = await runPromise(
      StepKey.content({ body: 1, inputs: {}, layers: ["a", "b"], capabilities: { fs: ["r"] } })
    )
    const undeclared = await runPromise(StepKey.content({
      body: 1,
      inputs: {},
      layers: ["a"],
      capabilities: {},
      environment: { declared: false, layers: ["b"], capabilities: { fs: ["r"] }, runScope: "run-1" }
    }))
    const reordered = await runPromise(StepKey.content({
      body: 1,
      inputs: {},
      layers: ["a"],
      capabilities: {},
      environment: { declared: true, layers: ["b", "c"], capabilities: {} }
    }))
    const swapped = await runPromise(StepKey.content({
      body: 1,
      inputs: {},
      layers: ["a"],
      capabilities: {},
      environment: { declared: true, layers: ["c", "b"], capabilities: {} }
    }))
    expect(separate).not.toBe(merged)
    expect(separate).not.toBe(undeclared)
    expect(reordered).not.toBe(swapped)
  })

  it("normalizes and dedupes the hermetic declaration", async () => {
    const left = await runPromise(StepKey.content({
      body: 1,
      inputs: {},
      layers: [],
      capabilities: {},
      hermetic: {
        readSet: [{ path: "b", digest: "2" }, { path: "a", digest: "1" }, { path: "a", digest: "1" }, {
          path: "a",
          digest: "0"
        }],
        writeSet: ["out", "out"],
        boundaryMode: "hard"
      }
    }))
    const right = await runPromise(StepKey.content({
      body: 1,
      inputs: {},
      layers: [],
      capabilities: {},
      hermetic: {
        readSet: [{ path: "a", digest: "0" }, { path: "a", digest: "1" }, { path: "b", digest: "2" }],
        writeSet: ["out"],
        boundaryMode: "hard"
      }
    }))
    expect(left).toBe(right)
  })

  it("makes an ordinal key run-local", async () => {
    const first = await runPromise(StepKey.ordinal({ runId: "run-1", ordinal: 1, tier: "unsealed" }))
    const second = await runPromise(StepKey.ordinal({ runId: "run-2", ordinal: 1, tier: "unsealed" }))
    expect(first).not.toBe(second)
  })

  it("substitutes dependency digests and tags every reference variant", async () => {
    const digests = { upstream: "key1_upstream" }
    const pending = await runPromise(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Pending", from: "upstream" }] }), digests)
    )
    const plain = await runPromise(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }), digests)
    )
    const projected = await runPromise(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: ["a"] }] }), digests)
    )
    const literal = await runPromise(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Literal", value: 1 }] }), digests)
    )
    expect(new Set([pending, plain, projected, literal]).size).toBe(4)
  })

  it("keeps a literal that spells a digest reference distinct from the reference (D7)", async () => {
    // `fromKeyMaterial` now builds `DigestInput` values and lets
    // `normalizeInputs` be the single normalizer, instead of hand-building
    // `{kind: "ref", digest}` objects that were then wrapped a second time as
    // `{kind: "literal", value: <that object>}`. The double wrap was what made
    // this collision impossible before; the nominal `DigestInputTypeId` brand
    // is what makes it impossible now. A literal value can spell the digest
    // reference's normalized form exactly and still cannot be mistaken for it.
    const digests = { upstream: "key1_upstream" }
    const reference = await runPromise(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }), digests)
    )
    const impostor = await runPromise(
      StepKey.fromKeyMaterial(
        material({
          inputs: [{ _tag: "Literal", value: { kind: "digest", digest: "key1_upstream", reference: "ref" } }]
        }),
        digests
      )
    )
    const projectedImpostor = await runPromise(
      StepKey.fromKeyMaterial(
        material({
          inputs: [{
            _tag: "Literal",
            value: { kind: "digest", digest: "key1_upstream", reference: "ref-projected", path: ["a"] }
          }]
        }),
        digests
      )
    )
    const projected = await runPromise(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: ["a"] }] }), digests)
    )

    expect(new Set([reference, impostor, projected, projectedImpostor]).size).toBe(4)
  })

  it("keeps an untagged digest input distinct from a graph reference (D7)", async () => {
    // A caller-supplied `digestInput(d)` carries no `reference`, so it must not
    // collide with the `ref` variant `fromKeyMaterial` produces for the same
    // digest. This is the corner the new discriminator opens.
    const untagged = await runPromise(
      StepKey.content({
        body: { version: 1, declaration: "step" },
        inputs: { "0": StepKey.digestInput("key1_upstream") },
        layers: [],
        capabilities: { declared: [] }
      })
    )
    const tagged = await runPromise(
      StepKey.content({
        body: { version: 1, declaration: "step" },
        inputs: { "0": StepKey.digestInput("key1_upstream", { reference: "ref" }) },
        layers: [],
        capabilities: { declared: [] }
      })
    )

    expect(untagged).not.toBe(tagged)
  })

  it("folds effects, placement, and the material version into the body", async () => {
    const base = await runPromise(StepKey.fromKeyMaterial(material(), {}))
    const withEffects = await runPromise(StepKey.fromKeyMaterial(material({ effects: { net: true } }), {}))
    const withPlacement = await runPromise(StepKey.fromKeyMaterial(material({ placement: "edge" }), {}))
    expect(new Set([base, withEffects, withPlacement]).size).toBe(3)
  })

  it("refuses material with no digest for a declared dependency", async () => {
    const failure = await runFailure(
      StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "missing", path: [] }] }), {})
    )
    expect(failure).toMatchObject({ code: "missing_dependency" })
  })

  it("refuses non-content material", async () => {
    const failure = await runFailure(StepKey.fromKeyMaterial(material({ kind: "irreversible" }), {}))
    expect(failure).toMatchObject({ code: "non_content_material" })
  })

  it("surfaces a canonicalization failure as a typed schema error", async () => {
    const failure = await runFailure(
      Effect.asVoid(StepKey.content({ body: 1n, inputs: {}, layers: [], capabilities: {} }))
    )
    expect(failure).toBeDefined()
  })
})

describe("KeyMaterial.dependencies", () => {
  it("lists graph references once, in declaration order, skipping literals", () => {
    expect(KeyMaterial.dependencies(material({
      inputs: [
        { _tag: "Literal", value: 1 },
        { _tag: "Ref", from: "b", path: [] },
        { _tag: "Pending", from: "a" },
        { _tag: "Ref", from: "b", path: ["x"] }
      ]
    }))).toEqual(["b", "a"])
  })
})
