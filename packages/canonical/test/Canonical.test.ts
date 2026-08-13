// Deep reviewed and polished by a human on 2026-08-10.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Canonical } from "../src/index.ts"

const serialize = (value: unknown): Canonical => Effect.runSync(Schema.decodeUnknownEffect(Canonical)(value))

const failure = (value: unknown) => Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Canonical)(value)))

const failureMessage = (value: unknown): string => failure(value).message

describe("Canonical", () => {
  it("canonicalizes through schema decoding", () => {
    expect(Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })).toBe("{\"a\":1,\"b\":2}")
  })

  it("produces valid JSON", () => {
    const document = serialize({ b: 2, a: [true, null] })
    expect(JSON.parse(document)).toEqual({ a: [true, null], b: 2 })
  })

  it("decodes a canonical document back into its JSON value", () => {
    const document = serialize({ b: 2, a: [true, null] })
    expect(Schema.encodeUnknownSync(Canonical)(document)).toEqual({ a: [true, null], b: 2 })
  })
})

describe("arrays", () => {
  it.each([
    ["empty array", [], "[]"],
    ["one element array", [123], "[123]"],
    ["multiple element array", [123, 456, "hello"], "[123,456,\"hello\"]"],
    ["null and undefined values", [null, undefined, "hello"], "[null,null,\"hello\"]"],
    ["object in array", [{ b: 123, a: "string" }], "[{\"a\":\"string\",\"b\":123}]"]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("objects", () => {
  it.each([
    ["empty object", {}, "{}"],
    ["undefined value", { test: undefined }, "{}"],
    ["null value", { test: null }, "{\"test\":null}"],
    ["one property", { hello: "world" }, "{\"hello\":\"world\"}"],
    ["multiple properties", { hello: "world", number: 123 }, "{\"hello\":\"world\",\"number\":123}"],
    ["numeric key", { 42: "foo" }, "{\"42\":\"foo\"}"],
    ["symbol value", { test: Symbol("hello world") }, "{}"],
    ["symbol key", { [Symbol("hello world")]: "foo" }, "{}"]
  ])("serializes an object with %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("primitive values", () => {
  it("serializes null", () => {
    expect(serialize(null)).toBe("null")
  })

  it.each([
    ["undefined", undefined],
    ["symbol", Symbol("hello world")]
  ])("rejects a top-level %s because the wrapper requires string output", (_name, input) => {
    expect(failureMessage(input)).toContain("The value is not valid JSON")
  })
})

describe("non-finite numbers", () => {
  it.each([
    ["NaN in an array", [Number.NaN], "NaN is not allowed"],
    ["NaN in an object", { key: Number.NaN }, "NaN is not allowed"],
    ["top-level NaN", Number.NaN, "NaN is not allowed"],
    ["Infinity in an array", [Number.POSITIVE_INFINITY], "Infinity is not allowed"],
    ["Infinity in an object", { key: Number.POSITIVE_INFINITY }, "Infinity is not allowed"],
    ["top-level -Infinity", Number.NEGATIVE_INFINITY, "Infinity is not allowed"]
  ])("rejects %s", (_name, input, message) => {
    expect(failureMessage(input)).toContain(message)
  })
})

describe("Unicode", () => {
  it.each([
    ["lone high surrogate in a value", { key: "\uD800" }],
    ["lone low surrogate in a value", { key: "\uDEAD" }],
    ["high surrogate before a non-low-surrogate", { key: "\uD800a" }],
    ["lone surrogate in an object key", { ["\uD800"]: "value" }]
  ])("rejects a %s", (_name, input) => {
    expect(failure(input)).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })

  it("allows a valid surrogate pair", () => {
    expect(serialize({ key: "\uD83D\uDE00" })).toBe("{\"key\":\"😀\"}")
  })
})

describe("toJSON", () => {
  it("uses an object's toJSON result", () => {
    const input = {
      a: 123,
      b: 456,
      toJSON() {
        return { b: this.b, a: this.a }
      }
    }
    expect(serialize(input)).toBe("{\"a\":123,\"b\":456}")
  })

  it("serializes nested toJSON results recursively", () => {
    expect(serialize({ x: { toJSON: () => ({ z: 1, a: 2 }) } })).toBe("{\"x\":{\"a\":2,\"z\":1}}")
  })

  it("rejects NaN returned by toJSON", () => {
    expect(failureMessage({ toJSON: () => Number.NaN })).toContain("NaN is not allowed")
  })

  it("reports a non-Error thrown by toJSON", () => {
    expect(failureMessage({
      toJSON: () => {
        throw "broken"
      }
    })).toContain("broken")
  })

  it("rejects toJSON returning its object", () => {
    const input: { toJSON?: () => unknown } = {}
    input.toJSON = () => input
    expect(failureMessage(input)).toContain("Circular reference detected")
  })
})

describe("circular references", () => {
  it("rejects an object referencing itself", () => {
    const input: Record<string, unknown> = {}
    input.self = input
    expect(failureMessage(input)).toContain("Circular reference detected")
  })

  it("rejects an array referencing itself", () => {
    const input: Array<unknown> = []
    input.push(input)
    expect(failureMessage(input)).toContain("Circular reference detected")
  })

  it("rejects a nested circular reference", () => {
    const a: Record<string, unknown> = {}
    const b = { a }
    a.b = b
    expect(failureMessage(a)).toContain("Circular reference detected")
  })

  it("allows the same non-circular object twice", () => {
    const shared = { z: 1 }
    expect(serialize({ x: shared, y: shared })).toBe("{\"x\":{\"z\":1},\"y\":{\"z\":1}}")
  })
})

describe("upstream RFC fixtures", () => {
  it.each([
    ["arrays", [56, { d: true, 10: null, 1: [] }], "[56,{\"1\":[],\"10\":null,\"d\":true}]"],
    [
      "French sorting",
      {
        peach: "This sorting order",
        "péché": "is wrong according to French",
        "pêche": "but canonicalization MUST",
        sin: "ignore locale"
      },
      "{\"peach\":\"This sorting order\",\"péché\":\"is wrong according to French\",\"pêche\":\"but canonicalization MUST\",\"sin\":\"ignore locale\"}"
    ],
    [
      "structures",
      {
        1: { f: { f: "hi", F: 5 }, "\n": 56 },
        10: {},
        "": "empty",
        a: {},
        111: [{ e: "yes", E: "no" }],
        A: { b: "123" }
      },
      "{\"\":\"empty\",\"1\":{\"\\n\":56,\"f\":{\"F\":5,\"f\":\"hi\"}},\"10\":{},\"111\":[{\"E\":\"no\",\"e\":\"yes\"}],\"A\":{\"b\":\"123\"},\"a\":{}}"
    ],
    [
      "values",
      {
        numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
        string: "€$\u000F\nA'B\"\\\\\"/",
        literals: [null, true, false]
      },
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}"
    ],
    [
      "weird property names",
      {
        "€": "Euro Sign",
        1: "One",
        "\u0080": "Control",
        "😂": "Smiley",
        "ö": "Latin Small Letter O With Diaeresis",
        "דּ": "Hebrew Letter Dalet With Dagesh",
        "</script>": "Browser Challenge"
      },
      "{\"1\":\"One\",\"</script>\":\"Browser Challenge\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😂\":\"Smiley\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}"
    ]
  ])("matches the %s fixture", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })
})

describe("numeric boundaries", () => {
  it.each([
    ["zero", 0, "0"],
    ["negative zero", -0, "0"],
    ["smallest positive subnormal", Number.MIN_VALUE, "5e-324"],
    ["largest finite number", Number.MAX_VALUE, "1.7976931348623157e+308"],
    ["largest safe integer", Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["smallest safe integer", Number.MIN_SAFE_INTEGER, "-9007199254740991"],
    ["exponential lower boundary", 1e-7, "1e-7"],
    ["decimal lower boundary", 1e-6, "0.000001"],
    ["decimal upper boundary", 1e20, "100000000000000000000"],
    ["exponential upper boundary", 1e21, "1e+21"]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })

  it("rejects bigint", () => {
    expect(failure(1n)).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })
})

describe("string boundaries", () => {
  it.each([
    ["empty string", "", "\"\""],
    ["quotation mark", "\"", "\"\\\"\""],
    ["reverse solidus", "\\", "\"\\\\\""],
    ["backspace", "\b", "\"\\b\""],
    ["form feed", "\f", "\"\\f\""],
    ["line feed", "\n", "\"\\n\""],
    ["carriage return", "\r", "\"\\r\""],
    ["tab", "\t", "\"\\t\""],
    ["lowest control character", "\u0000", "\"\\u0000\""],
    ["highest control character", "\u001f", "\"\\u001f\""],
    ["BMP boundary", "\uffff", "\"￿\""],
    ["highest Unicode scalar", "\uDBFF\uDFFF", "\"􏿿\""]
  ])("serializes %s", (_name, input, expected) => {
    expect(serialize(input)).toBe(expected)
  })

  it("preserves distinct NFC and NFD spellings", () => {
    expect(serialize("é")).not.toBe(serialize("e\u0301"))
  })

  it("serializes a one-megabyte string without truncation", () => {
    const value = "x".repeat(1024 * 1024)
    const output = serialize(value)
    expect(output.length).toBe(value.length + 2)
    expect(output).toBe(`"${value}"`)
  })
})

describe("collection boundaries", () => {
  it("uses UTF-16 code-unit order for property names", () => {
    expect(serialize({ "\uE000": 1, "😀": 2, a: 3, A: 4 })).toBe("{\"A\":4,\"a\":3,\"😀\":2,\"\":1}")
  })

  it("retains array order and duplicate values", () => {
    expect(serialize([3, 1, 3, 2])).toBe("[3,1,3,2]")
  })

  it("rejects a sparse array rather than returning invalid JSON", () => {
    const sparse = new Array<unknown>(3)
    sparse[2] = "end"
    expect(failure(sparse)).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })

  it("serializes ten thousand array elements", () => {
    const input = Array.from({ length: 10_000 }, (_, index) => index)
    expect(serialize(input)).toBe(JSON.stringify(input))
  })

  it("sorts ten thousand object properties", () => {
    const input = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key-${10_000 - index}`, index]))
    const output = serialize(input)
    expect(Object.keys(JSON.parse(output) as object)).toEqual(Object.keys(input).sort())
  })

  it("serializes deeply nested JSON", () => {
    let input: unknown = "leaf"
    for (let index = 0; index < 200; index++) input = { child: input }
    expect(JSON.parse(serialize(input))).toEqual(input)
  })

  it("does not mistake many shared references for cycles", () => {
    const shared = { value: true }
    const input = Array.from({ length: 1_000 }, () => shared)
    expect(JSON.parse(serialize(input))).toEqual(input)
  })
})

describe("unsupported value boundaries", () => {
  it.each([
    ["function at the top level", () => undefined],
    ["symbol at the top level", Symbol("value")],
    ["undefined at the top level", undefined]
  ])("fails for %s", (_name, input) => {
    expect(failureMessage(input)).toContain("The value is not valid JSON")
  })

  it("rejects a function-valued object property rather than returning invalid JSON", () => {
    expect(failure({ kept: true, omitted: () => undefined })).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
  })

  it("omits a function-valued array element", () => {
    expect(serialize([() => undefined])).toBe("[]")
  })
})

describe("Canonical repeated-reference validation", () => {
  it("validates both occurrences of an object that appears twice", () => {
    // `validateUnicode` carries a `WeakSet` of visited objects and skips
    // repeats, which is correct only because the FIRST visit validated them.
    // Nothing asserted that, so a future change that made the skip happen
    // before validation — or that seeded the set from the wrong place — would
    // let a lone surrogate through on its second appearance and produce a
    // digest another host disagrees with.
    const invalid = { text: "lone \ud800 surrogate" }

    // Reached first through `a`, skipped at `b`: the rejection must come from
    // the first visit.
    expect(failure({ a: invalid, b: invalid })).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
    // And the same object repeated inside an array, where the skip is the
    // second element rather than a sibling key.
    expect(failure([invalid, invalid])).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
    // A valid object repeated is not rejected by the skip either — the set
    // suppresses re-walking, not the result.
    const shared = { text: "fine" }
    expect(serialize({ a: shared, b: shared })).toBe("{\"a\":{\"text\":\"fine\"},\"b\":{\"text\":\"fine\"}}")
  })

  it("rejects a value whose only invalid occurrence is the repeated one", () => {
    // The ordering half: the invalid object is visited first at `a`, so the
    // `seen` skip at `b` can never be what decides validity.
    const invalid = { text: "\udfff" }
    expect(failure({ a: { nested: invalid }, b: invalid })).toEqual(
      expect.objectContaining({ _tag: "SchemaError" })
    )
  })
})
