import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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

  it("normalizes tree, glob, and removal declarations", async () => {
    const identity = (
      writeSet: NonNullable<StepKey.ContentIdentity["hermetic"]>["writeSet"],
      removes: ReadonlyArray<string>
    ) =>
      StepKey.content({
        body: 1,
        inputs: {},
        layers: [],
        capabilities: {},
        hermetic: { readSet: [], writeSet, removes, boundaryMode: "hard" }
      })
    const left = await runPromise(identity([
      { _tag: "Glob", include: ["src/**/*.ts", "src/**/*.ts"], exclude: ["src/z.ts", "src/a.ts"] },
      { _tag: "Glob", include: ["assets/**"] },
      { _tag: "TreeArtifact", path: "dist" },
      "out"
    ], ["stale/z", "stale/a", "stale/a"]))
    const right = await runPromise(identity([
      "out",
      { _tag: "Glob", include: ["assets/**"] },
      { _tag: "TreeArtifact", path: "dist" },
      { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/a.ts", "src/z.ts"] }
    ], ["stale/a", "stale/z"]))
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

describe("StepKey.dispatchIdentity", () => {
  const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
    readSet: [{ path: "src/a.ts", digest: "sha256:a" }],
    writeSet: ["out/a.js"],
    boundaryMode: "hard"
  }

  const dispatch = (
    overrides: Partial<KeyMaterial.KeyMaterial>,
    results: Readonly<Record<string, unknown>>,
    boundary: typeof hermetic = hermetic
  ) => StepKey.dispatchIdentity({ material: material(overrides), results, hermetic: boundary })

  it("memoizes a projected value digest across concurrent key computations", async () => {
    let digestCalls = 0
    const countingCrypto = Layer.effect(
      Crypto.Crypto,
      Effect.map(Crypto.Crypto, (crypto) =>
        Crypto.Crypto.of({
          ...crypto,
          digest: (algorithm, data) =>
            Effect.sync(() => {
              digestCalls = digestCalls + 1
            }).pipe(Effect.andThen(crypto.digest(algorithm, data)))
        }))
    ).pipe(Layer.provide(NodeCrypto.layer))
    const inputs = [{ _tag: "Ref", from: "upstream", path: ["value"] }] as const
    const options = {
      material: material({ inputs }),
      results: { upstream: { value: { nested: true } } },
      hermetic
    }
    const digestMemo = StepKey.makeDigestMemo()
    const memoized = await Effect.runPromise(
      Effect.all([
        StepKey.dispatchIdentity({ ...options, digestMemo }),
        StepKey.dispatchIdentity({ ...options, digestMemo })
      ], { concurrency: "unbounded" }).pipe(Effect.provide(countingCrypto))
    )
    const unmemoized = await runPromise(StepKey.dispatchIdentity(options))
    // One projected-value digest plus one final key digest per call.
    expect(digestCalls).toBe(3)
    expect(memoized).toEqual([unmemoized, unmemoized])
  })

  it("folds an engine-resolved environment without moving the absent identity", async () => {
    const absent = await runPromise(dispatch({}, {}))
    const environment: StepKey.EnvironmentIdentity = {
      declared: false,
      layers: ["node-crypto", "workspace"],
      capabilities: { fs: ["read", "write"] }
    }
    const present = await runPromise(StepKey.dispatchIdentity({
      material: material(),
      results: {},
      hermetic,
      environment
    }))
    const scoped = await runPromise(StepKey.dispatchIdentity({
      material: material(),
      results: {},
      hermetic,
      environment: { ...environment, runScope: "run-1" }
    }))
    expect(absent).toBe("key1_70bc16b1ef9256f7301167c9d11f332d39383c61d9f630d99bdc920c066b6ac2")
    expect(present).not.toBe(absent)
    expect(scoped).not.toBe(present)
  })

  it("folds the settled output value of a `Ref`, never the upstream's identity", async () => {
    // The early cutoff: the derivation is handed the upstream's VALUE and
    // nothing else, so there is no channel through which an upstream body
    // edit that left the output byte-identical could reach this key.
    const inputs = [{ _tag: "Ref", from: "upstream", path: [] }] as const
    const first = await runPromise(dispatch({ inputs }, { upstream: { count: 1 } }))
    const again = await runPromise(dispatch({ inputs }, { upstream: { count: 1 } }))
    const changed = await runPromise(dispatch({ inputs }, { upstream: { count: 2 } }))
    expect(first).toBe(again)
    expect(first).not.toBe(changed)
  })

  it("projects a `Ref` path, so a sibling field of the upstream result cannot re-key it", async () => {
    const inputs = [{ _tag: "Ref", from: "upstream", path: ["taken"] }] as const
    const base = await runPromise(dispatch({ inputs }, { upstream: { taken: "x", ignored: 1 } }))
    const sibling = await runPromise(dispatch({ inputs }, { upstream: { taken: "x", ignored: 2 } }))
    const projected = await runPromise(dispatch({ inputs }, { upstream: { taken: "y", ignored: 1 } }))
    expect(base).toBe(sibling)
    expect(base).not.toBe(projected)
  })

  it("digests a projection that walks off the end as a stable, distinct value", async () => {
    const deep = [{ _tag: "Ref", from: "upstream", path: ["a", "b"] }] as const
    const offScalar = await runPromise(dispatch({ inputs: deep }, { upstream: { a: "scalar" } }))
    const offNull = await runPromise(dispatch({ inputs: deep }, { upstream: { a: null } }))
    const offMissing = await runPromise(dispatch({ inputs: deep }, { upstream: {} }))
    const present = await runPromise(dispatch({ inputs: deep }, { upstream: { a: { b: null } } }))
    // Every way of missing is the same absence; an explicit `null` is not it.
    expect(new Set([offScalar, offNull, offMissing]).size).toBe(1)
    expect(present).not.toBe(offScalar)
  })

  it("keeps a projected reference distinct from the unprojected one", async () => {
    const flat = await runPromise(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: { a: 1 } }))
    const nested = await runPromise(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: ["a"] }] }, { u: { a: 1 } }))
    const bare = await runPromise(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1 }))
    expect(nested).not.toBe(bare)
    expect(flat).not.toBe(nested)
  })

  it("folds nothing but a tag for `Pending`: ordering does not change what a node consumes", async () => {
    const inputs = [{ _tag: "Pending", from: "before" }] as const
    const one = await runPromise(dispatch({ inputs }, { before: { anything: 1 } }))
    const other = await runPromise(dispatch({ inputs }, { before: "completely different" }))
    expect(one).toBe(other)
  })

  it("keeps a literal that spells a resolved reference distinct from the reference", async () => {
    const reference = await runPromise(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1 }))
    const digest = await runPromise(StepKey.content({ body: 0, inputs: { "0": 1 }, layers: [], capabilities: {} }))
    const impostor = await runPromise(
      dispatch({ inputs: [{ _tag: "Literal", value: { kind: "digest", digest, reference: "ref" } }] }, { u: 1 })
    )
    expect(reference).not.toBe(impostor)
  })

  it("folds the node's own declaration and the measured boundary", async () => {
    const base = await runPromise(dispatch({}, {}))
    const body = await runPromise(dispatch({ body: { action: "compile" } }, {}))
    const effects = await runPromise(dispatch({ effects: { net: true } }, {}))
    const placement = await runPromise(dispatch({ placement: "edge" }, {}))
    const layers = await runPromise(dispatch({ layers: ["fs"] }, {}))
    const capabilities = await runPromise(dispatch({ capabilities: ["fs:read"] }, {}))
    const measured = await runPromise(
      dispatch({}, {}, { ...hermetic, readSet: [{ path: "src/a.ts", digest: "sha256:b" }] })
    )
    expect(new Set([base, body, effects, placement, layers, capabilities, measured]).size).toBe(7)
  })

  it("folds declared removals into the dispatch identity", async () => {
    const base = await runPromise(dispatch({}, {}))
    const removing = await runPromise(dispatch({}, {}, { ...hermetic, removes: ["out/stale.js"] }))
    expect(removing).not.toBe(base)
  })

  it("refuses material naming a dependency that has not settled", async () => {
    const failure = await runFailure(dispatch({ inputs: [{ _tag: "Ref", from: "missing", path: [] }] }, {}))
    expect(failure).toMatchObject({ code: "missing_dependency" })
  })

  it("refuses non-content material", async () => {
    expect(await runFailure(dispatch({ kind: "irreversible" }, {}))).toMatchObject({ code: "non_content_material" })
  })

  it("surfaces a canonicalization failure as a typed schema error", async () => {
    const failure = await runFailure(
      Effect.asVoid(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1n }))
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
