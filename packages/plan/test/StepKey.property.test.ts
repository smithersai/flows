import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import { runPromise } from "./Crypto.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

/** Path segments biased toward prototype-chain keys and serialization hazards. */
const hostileSegment = FastCheck.oneof(
  FastCheck.constantFrom(
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "length",
    "0",
    "1",
    ""
  ),
  FastCheck.string({ unit: "binary", maxLength: 6 })
)

const hostilePath = FastCheck.array(hostileSegment, { maxLength: 5 })

/** Arbitrary values including non-JSON shapes (undefined, sparse objects). */
const anyValue = FastCheck.oneof(FastCheck.jsonValue({ stringUnit: "binary" }), FastCheck.anything())

/** JSON restricted to well-formed strings, so canonicalization always succeeds. */
const cleanJson = FastCheck.jsonValue({ stringUnit: "grapheme" })

const cleanString = FastCheck.string({ unit: "grapheme", maxLength: 6 })

/** A content identity whose inputs are all literals, so it survives structuredClone. */
const literalIdentity = FastCheck.record({
  body: cleanJson,
  inputs: FastCheck.dictionary(cleanString, cleanJson, { maxKeys: 3 }),
  layers: FastCheck.array(cleanString, { maxLength: 4 }),
  capabilities: FastCheck.dictionary(cleanString, FastCheck.array(cleanString, { maxLength: 3 }), { maxKeys: 3 })
})

const sealed = (overrides: Partial<KeyMaterial.KeyMaterial> = {}): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body: { action: "render" },
  inputs: [],
  layers: [],
  capabilities: [],
  ...overrides
})

describe("StepKey.project properties", () => {
  // Pinned counterexample corpus; runs before random inputs, forever.
  const projectCorpus: Array<[unknown, Array<string>]> = [
    [{}, ["__proto__", "constructor"]],
    [Object.create(null), ["toString"]],
    [[0], ["0", "valueOf", "length"]],
    [null, [""]],
    ["text", ["length"]],
    [{ a: undefined }, ["a", "b"]]
  ]

  it("is total and stable: any value with any hostile path yields the same value or undefined, never a throw", () => {
    FastCheck.assert(
      FastCheck.property(anyValue, hostilePath, (value, path) => {
        const first = StepKey.project(value, path)
        const second = StepKey.project(value, path)
        expect(Object.is(first, second)).toBe(true)
      }),
      { ...params, examples: projectCorpus }
    )
  })

  it("projects the empty path as identity and concatenated paths compose", () => {
    FastCheck.assert(
      FastCheck.property(anyValue, hostilePath, hostilePath, (value, first, second) => {
        expect(Object.is(StepKey.project(value, []), value)).toBe(true)
        const direct = StepKey.project(value, [...first, ...second])
        const staged = StepKey.project(StepKey.project(value, first), second)
        expect(Object.is(direct, staged)).toBe(true)
      }),
      params
    )
  })
})

describe("StepKey.content properties", () => {
  it("is total on hostile JSON: every outcome is a key or a typed SchemaError, never a defect", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(FastCheck.jsonValue({ stringUnit: "binary" }), async (body) => {
        // A defect would reject runPromise and fail the property; a lone
        // surrogate must surface as the typed canonicalization error.
        const outcome = await runPromise(
          StepKey.content({ body, inputs: { hostile: body }, layers: [], capabilities: {} }).pipe(
            Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "key" })
          )
        )
        expect(outcome === "key" || outcome === "SchemaError").toBe(true)
      }),
      { ...params, examples: [[{ "\uD800": "\uDFFF" }], ["\uD800"], [{ "": null }]] }
    )
  })

  it("keys structure, not identity: rehashing and a structural clone are byte-identical", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(literalIdentity, async (identity) => {
        const first = await runPromise(StepKey.content(identity))
        const again = await runPromise(StepKey.content(identity))
        const cloned = await runPromise(StepKey.content(structuredClone(identity)))
        expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
        expect(again).toBe(first)
        expect(cloned).toBe(first)
      }),
      params
    )
  })

  it("hashes layers and capability patterns as NFC-normalized sets: order, duplication, and composed form never re-key", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.array(cleanString, { maxLength: 4 }),
        FastCheck.array(cleanString, { maxLength: 4 }),
        async (layers, patterns) => {
          const canonical = await runPromise(
            StepKey.content({ body: 0, inputs: {}, layers, capabilities: { fs: patterns } })
          )
          const scrambled = await runPromise(
            StepKey.content({
              body: 0,
              inputs: {},
              layers: [...layers].reverse().concat(layers).map((layer) => layer.normalize("NFD")),
              capabilities: {
                fs: [...patterns].reverse().concat(patterns).map((pattern) => pattern.normalize("NFD"))
              }
            })
          )
          expect(scrambled).toBe(canonical)
        }
      ),
      { ...params, examples: [[["é", "é"], []]] }
    )
  })

  it("never lets a literal spelling of any digest-reference shape collide with the branded input", async () => {
    const variant = FastCheck.constantFrom("none", "ref", "pending", "ref-projected")
    const digest = FastCheck.string({ unit: "grapheme", maxLength: 12 })
    const projection = FastCheck.array(cleanString, { maxLength: 3 })
    await FastCheck.assert(
      FastCheck.asyncProperty(digest, variant, projection, async (value, kind, path) => {
        const reference = kind === "none"
          ? undefined
          : kind === "ref-projected"
          ? { reference: kind, path }
          : { reference: kind }
        const branded = await runPromise(
          StepKey.content({
            body: 0,
            inputs: { input: StepKey.digestInput(value, reference) },
            layers: [],
            capabilities: {}
          })
        )
        const impostor = await runPromise(
          StepKey.content({
            body: 0,
            inputs: {
              input: {
                kind: "digest",
                digest: value,
                ...(reference === undefined ? {} : { reference: reference.reference }),
                ...(kind === "ref-projected" ? { path } : {})
              }
            },
            layers: [],
            capabilities: {}
          })
        )
        expect(impostor).not.toBe(branded)
      }),
      params
    )
  })

  it("keys every reference variant of one digest distinctly", async () => {
    const digest = FastCheck.string({ unit: "grapheme", maxLength: 12 })
    const projection = FastCheck.array(cleanString, { maxLength: 3 })
    const keyOf = (input: unknown) =>
      runPromise(StepKey.content({ body: 0, inputs: { input }, layers: [], capabilities: {} }))
    await FastCheck.assert(
      FastCheck.asyncProperty(digest, projection, async (value, path) => {
        const keys = await Promise.all([
          keyOf(StepKey.digestInput(value)),
          keyOf(StepKey.digestInput(value, { reference: "ref" })),
          keyOf(StepKey.digestInput(value, { reference: "pending" })),
          keyOf(StepKey.digestInput(value, { reference: "ref-projected", path })),
          keyOf({ digest: value })
        ])
        expect(new Set(keys).size).toBe(keys.length)
      }),
      params
    )
  })
})

describe("StepKey.fromKeyMaterial properties", () => {
  const materialArb = Schema.toArbitrary(KeyMaterial.KeyMaterial)(FastCheck)

  it("is deterministic over the whole material schema: equal material yields equal keys or equal typed errors", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(materialArb, async (material) => {
        const digests = Object.fromEntries(
          KeyMaterial.dependencies(material).map((name) => [name, `key1_${name}`])
        )
        const observe = () =>
          runPromise(
            StepKey.fromKeyMaterial(material, digests).pipe(
              Effect.match({
                onFailure: (error) => (error instanceof StepKey.KeyMaterialError ? `error:${error.code}` : error._tag),
                onSuccess: (key) => `key:${key}`
              })
            )
          )
        expect(await observe()).toBe(await observe())
      }),
      params
    )
  })
})

describe("StepKey.dispatchIdentity properties", () => {
  const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
    readSet: [],
    writeSet: [],
    boundaryMode: "hard"
  }

  const dispatch = (path: ReadonlyArray<string>, results: Readonly<Record<string, unknown>>) =>
    StepKey.dispatchIdentity({
      material: sealed({ inputs: [{ _tag: "Ref", from: "up", path: [...path] }] }),
      results,
      hermetic
    })

  it("keys on the projected settled value: a structural clone of the results is byte-identical", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(FastCheck.array(cleanString, { maxLength: 3 }), cleanJson, async (path, settled) => {
        const results = { up: settled }
        const first = await runPromise(dispatch(path, results))
        const cloned = await runPromise(dispatch(path, structuredClone(results)))
        expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
        expect(cloned).toBe(first)
      }),
      params
    )
  })

  it("keys distinct projected values distinctly", async () => {
    const distinctPair = FastCheck.tuple(FastCheck.integer(), FastCheck.integer())
      .filter(([left, right]) => left !== right)
    await FastCheck.assert(
      FastCheck.asyncProperty(distinctPair, async ([left, right]) => {
        const first = await runPromise(dispatch([], { up: left }))
        const second = await runPromise(dispatch([], { up: right }))
        expect(first).not.toBe(second)
      }),
      params
    )
  })
})
