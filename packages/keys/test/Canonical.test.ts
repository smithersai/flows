import { Redacted, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Canonical from "../src/Canonical.ts"

describe("Canonical", () => {
  const serialize = (value: unknown): string => Result.getOrThrow(Canonical.serialize(value))

  it("sorts object keys, preserves arrays, normalizes NFC, and normalizes negative zero", () => {
    expect(serialize({ z: [2, 1], a: "e\u0301", n: -0 })).toBe(
      "flows-step-key-v1|o3:{s1:as1:és1:nd0;s1:za2:[d2;d1;]}"
    )
  })

  it("tags values by type", () => {
    expect(serialize({ a: 1 })).not.toBe(serialize({ a: "1" }))
    expect(serialize(true)).not.toBe(serialize(false))
    expect(serialize(null)).toBe("flows-step-key-v1|n;")
    expect(serialize(Object.assign(Object.create(null), { a: 1 }))).toBe(serialize({ a: 1 }))
  })

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol("x"),
    () => undefined,
    new Date(),
    Redacted.make("secret")
  ])("rejects unsupported values", (value) => {
    expect(Result.isFailure(Canonical.serialize(value))).toBe(true)
  })

  it("rejects sparse arrays and cycles", () => {
    const sparse = ["present", , "present"]
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(Result.isFailure(Canonical.serialize(sparse))).toBe(true)
    expect(Result.isFailure(Canonical.serialize(cycle))).toBe(true)
  })

  it("rejects symbol keys and accessors without evaluating them", () => {
    const symbolKeyed = { [Symbol("key")]: "value" }
    const accessor = Object.defineProperty({}, "value", { get: () => "value", enumerable: true })
    expect(Result.isFailure(Canonical.serialize(symbolKeyed))).toBe(true)
    expect(Result.isFailure(Canonical.serialize(accessor))).toBe(true)
  })

  it("maps a foreign reflection defect without laundering it as a canonical rejection", () => {
    const proxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("foreign reflection defect")
      }
    })
    const result = Canonical.serialize(proxy)
    expect(Result.isFailure(result)).toBe(true)
    expect(Result.isFailure(result) && result.failure.code).toBe("unsupported_type")
    expect(Result.isFailure(result) && result.failure.message).toBe("Canonical serialization failed")
  })
})
