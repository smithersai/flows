/**
 * The structured-output boundary: what the model is told, what is extracted
 * from its answer, and what a miss reports.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as StructuredOutput from "../src/StructuredOutput.ts"

const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

const attempt = { corrections: 0, limit: 1 }

const decode = <A>(schema: Schema.Codec<A>, text: string) =>
  Effect.runSync(Effect.result(StructuredOutput.decode(schema, text, attempt)))

describe("StructuredOutput.instructions", () => {
  it("renders the declared schema as JSON Schema in the teaching", () => {
    const text = StructuredOutput.instructions(Review)
    expect(text).toContain("Required output shape")
    expect(text).toContain("\"approved\"")
    expect(text).toContain("\"issues\"")
  })

  it("inlines definitions a suspended schema introduces", () => {
    interface Chain {
      readonly label: string
      readonly next: Chain | null
    }
    const Chain = Schema.Struct({
      label: Schema.String,
      next: Schema.suspend((): Schema.Codec<Chain | null> => Schema.NullOr(Chain))
    })
    expect(JSON.stringify(StructuredOutput.jsonSchema(Chain))).toContain("$defs")
  })
})

describe("StructuredOutput.digest", () => {
  it("names one boundary for two declarations that render the same shape", () => {
    expect(StructuredOutput.digest(Review)).toBe(
      StructuredOutput.digest(Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) }))
    )
    expect(StructuredOutput.digest(Review)).not.toBe(StructuredOutput.digest(Schema.String))
  })
})

describe("StructuredOutput.lastBalanced", () => {
  it("returns the container whose matching close ends last", () => {
    expect(StructuredOutput.lastBalanced("{\"a\":1} then {\"b\":2}")).toBe("{\"b\":2}")
  })

  it("scans arrays as well as objects", () => {
    expect(StructuredOutput.lastBalanced("prose [1, 2, [3]] tail")).toBe("[1, 2, [3]]")
  })

  it("ignores delimiters inside quoted strings and escapes", () => {
    expect(StructuredOutput.lastBalanced("{\"a\":\"}{\\\"\"}")).toBe("{\"a\":\"}{\\\"\"}")
  })

  it("abandons a container a mismatched close would misreport", () => {
    expect(StructuredOutput.lastBalanced("{\"a\": [1}")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("{\"a\": [1]}")).toBe("{\"a\": [1]}")
  })

  it("ignores a close with no opener, and reports nothing for prose", () => {
    expect(StructuredOutput.lastBalanced("} nothing opened")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("plain prose")).toBeUndefined()
  })

  it("does not open a string outside a container", () => {
    expect(StructuredOutput.lastBalanced("\"a quote\" then {\"b\":2}")).toBe("{\"b\":2}")
  })
})

describe("StructuredOutput.candidates", () => {
  it("offers the whole answer alone when it already is the container", () => {
    expect(StructuredOutput.candidates(" {\"a\":1} ")).toEqual(["{\"a\":1}"])
  })

  it("offers the whole answer first, then the extracted container", () => {
    expect(StructuredOutput.candidates("here: {\"a\":1}")).toEqual(["here: {\"a\":1}", "{\"a\":1}"])
  })
})

describe("StructuredOutput.decode", () => {
  it("decodes a bare document", () => {
    const result = decode(Review, "{\"approved\":true,\"issues\":[]}")
    expect(result._tag === "Success" ? result.success : undefined).toEqual({ approved: true, issues: [] })
  })

  it("strips a byte-order mark before parsing", () => {
    const result = decode(Review, "﻿{\"approved\":true,\"issues\":[]}")
    expect(result._tag).toBe("Success")
  })

  it("decodes a document wrapped in prose", () => {
    const result = decode(Review, "Sure:\n\n{\"approved\":false,\"issues\":[\"x\"]}\n\nDone.")
    expect(result._tag === "Success" ? result.success : undefined).toEqual({ approved: false, issues: ["x"] })
  })

  it("accepts a non-object root when the schema declares one", () => {
    const result = decode(Schema.Array(Schema.Number), "the answer is [1,2,3]")
    expect(result._tag === "Success" ? result.success : undefined).toEqual([1, 2, 3])
  })

  it("reports a typed failure with bounded diagnostics when nothing validates", () => {
    const result = decode(Review, "Looks fine to me.")
    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?._tag).toBe("/harness/StructuredOutputFailure")
    expect(failure?.schema).toBe(StructuredOutput.digest(Review))
    expect(failure?.corrections).toBe(0)
    expect(failure?.limit).toBe(1)
    expect(failure?.issues.length).toBeGreaterThan(0)
    expect(failure?.issues.length).toBeLessThanOrEqual(StructuredOutput.maxIssues)
  })

  it("reports the extracted container's issues when the whole answer is not JSON", () => {
    const result = decode(Review, "Verdict: {\"approved\":\"yes\"}")
    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.issues.join("\n")).toContain("approved")
  })

  it("renders a correction that restates only the diagnostics", () => {
    const result = decode(Review, "Looks fine to me.")
    const failure = result._tag === "Failure" ? result.failure : undefined
    const text = StructuredOutput.correction(failure!)
    expect(text).toContain("did not validate")
    expect(text).toContain(failure!.issues[0]!)
  })
})
