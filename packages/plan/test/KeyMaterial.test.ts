import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import { withCrypto } from "./Crypto.ts"

/**
 * One representative deterministic step: every channel the compiler folds is
 * populated, so a change to any of them moves the golden key below.
 */
const representative: KeyMaterial.KeyMaterial = {
  version: KeyMaterial.version,
  kind: "sealed",
  body: { action: "render", args: ["a", "b"] },
  inputs: [
    { _tag: "Literal", value: { seed: 1 } },
    { _tag: "Ref", from: "upstream", path: ["out"] },
    { _tag: "Pending", from: "gate" }
  ],
  layers: ["fs", "net"],
  capabilities: ["read"],
  effects: { net: true },
  placement: "edge"
}

const digests = { upstream: "digest-upstream", gate: "digest-gate" }

describe("KeyMaterial", () => {
  it.effect("keys a representative deterministic step to its recorded golden value", () =>
    Effect.gen(function*() {
      const key = yield* withCrypto(StepKey.fromKeyMaterial(representative, digests))

      // Recorded before `nondeterministic` was reconciled onto @smthrs/core's
      // interface. A change here invalidates every cache entry in the
      // repository, so treat a mismatch as a defect, not a baseline to bump.
      expect(key).toBe("key1_a89eda6de3a0f65f94edfb68079e023618abba597d4ea4f5248d1d204ed5caa5")
    }))

  it.effect("keys a nondeterministic step distinctly", () =>
    Effect.gen(function*() {
      const deterministic = yield* withCrypto(StepKey.fromKeyMaterial(representative, digests))
      const recorded = yield* withCrypto(
        StepKey.fromKeyMaterial({ ...representative, nondeterministic: true }, digests)
      )

      expect(recorded).toBe("key1_447439414af1a01a11a87d0f5eef8c9692cc99d8ebd482ef31b5155bb930c466")
      expect(recorded).not.toBe(deterministic)
    }))

  it.effect("leaves the key of material that omits the field untouched", () =>
    Effect.gen(function*() {
      const minimal: KeyMaterial.KeyMaterial = {
        version: KeyMaterial.version,
        kind: "sealed",
        body: { action: "render" },
        inputs: [],
        layers: [],
        capabilities: []
      }
      const key = yield* withCrypto(StepKey.fromKeyMaterial(minimal, {}))

      expect(key).toBe("key1_594e55424285180f3bcb35e6075d0e6961b6506cc15d78de0613eac91eeb9cd9")
    }))

  it.effect("decodes an explicit declaration and rejects a two-valued flag", () =>
    Effect.gen(function*() {
      const decode = Schema.decodeUnknownEffect(KeyMaterial.KeyMaterial)
      const encoded = { ...representative, nondeterministic: true }
      const decoded = yield* decode(encoded)
      const absent = yield* decode(representative)
      const refused = yield* Effect.flip(decode({ ...representative, nondeterministic: false }))

      expect(decoded.nondeterministic).toBe(true)
      expect(absent.nondeterministic).toBeUndefined()
      expect(refused._tag).toBe("SchemaError")
    }))

  it("names each graph-local dependency once, in declaration order", () => {
    expect(KeyMaterial.dependencies(representative)).toEqual(["upstream", "gate"])
    expect(KeyMaterial.dependencies({ ...representative, inputs: [] })).toEqual([])
  })
})
