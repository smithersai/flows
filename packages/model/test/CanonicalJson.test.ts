import { describe, expect, it } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"

describe("CanonicalJson", () => {
  it("encodes differently constructed objects as identical bytes", () => {
    const first: Record<string, unknown> = {}
    first["z"] = { b: 2, a: 1 }
    first["a"] = "value"
    const second: Record<string, unknown> = {}
    second["a"] = "value"
    second["z"] = { a: 1, b: 2 }

    expect([...CanonicalJson.bytes(first)]).toEqual([...CanonicalJson.bytes(second)])
    expect(CanonicalJson.stringify(first)).toBe("{\"a\":\"value\",\"z\":{\"a\":1,\"b\":2}}")
  })

  it("preserves array order", () => {
    expect(CanonicalJson.stringify({ a: [3, { a: 1 }, 2] })).toBe("{\"a\":[3,{\"a\":1},2]}")
  })

  it("rejects nested values which JSON.stringify would silently coerce", () => {
    for (
      const invalid of [
        { schema: { multipleOf: Number.NaN } },
        { schema: { generatedAt: new Date(0) } },
        { schema: { metadata: new Map([["key", "value"]]) } },
        { schema: { omitted: undefined } }
      ]
    ) {
      expect(() => CanonicalJson.stringify(invalid)).toThrow(/not valid JSON/)
    }
  })

  it("keeps pi's short-hash algorithm golden-vectored", () => {
    expect(CanonicalJson.shortHash("pi-tool-search")).toBe("10rp88s7t1h18")
  })
})
