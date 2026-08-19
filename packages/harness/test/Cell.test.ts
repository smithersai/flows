import * as Descriptor from "@smthrs/registry/Descriptor"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as FlowBinding from "../src/FlowBinding.ts"

const fenced = (info: string, body: string): string => "```" + info + "\n" + body + "\n```"

describe("Cell.extract", () => {
  it("takes the last fenced cell so illustrative snippets never win", () => {
    const text = [
      "I could do this:",
      fenced("cell", "return { intent: \"complete\", output: \"draft\" }"),
      "but on reflection:",
      fenced("cell", "return { intent: \"complete\", output: \"final\" }")
    ].join("\n\n")

    const extracted = Result.getOrThrow(Cell.extract(text))
    expect(extracted.text).toBe("return { intent: \"complete\", output: \"final\" }")
    expect(extracted.language).toBe("javascript")
  })

  it("accepts the js and javascript fences a model reaches for", () => {
    expect(Result.getOrThrow(Cell.extract(fenced("js", "return 1"))).language).toBe("javascript")
    expect(Result.getOrThrow(Cell.extract(fenced("javascript", "return 1"))).language).toBe("javascript")
    expect(Result.getOrThrow(Cell.extract(fenced("ts", "return 1"))).language).toBe("typescript")
  })

  it("reports a missing cell as a correctable rejection, not a failure", () => {
    const extracted = Cell.extract("I think we should stop here.")
    expect(extracted._tag).toBe("Failure")
    const rejection = (extracted as Result.Failure<never, Cell.Rejected>).failure
    expect(rejection.code).toBe("no_cell")
    expect(rejection.message).toContain("fenced ```cell block")
  })

  it("refuses any module access, which the sandbox has no way to satisfy", () => {
    for (
      const body of [
        "import { readFile } from \"node:fs\"\nreturn null",
        "const fs = require(\"node:fs\")\nreturn null",
        "export const x = 1\nreturn null",
        "const m = await import(\"node:fs\")\nreturn null"
      ]
    ) {
      const extracted = Cell.extract(fenced("cell", body))
      expect(extracted._tag).toBe("Failure")
      expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code).toBe("imports_forbidden")
    }
  })

  it("does not mistake an identifier ending in import for a module import", () => {
    const extracted = Cell.extract(fenced("cell", "const important = ctx.flows\nreturn { intent: \"park\" }"))
    expect(extracted._tag).toBe("Success")
  })
})

describe("Cell.source", () => {
  it("digests source stably and separates one character of difference", () => {
    expect(Cell.source("return 1").digest).toBe(Cell.source("return 1").digest)
    expect(Cell.source("return 1").digest).not.toBe(Cell.source("return 2").digest)
    expect(Cell.source("return 1", "javascript").digest).not.toBe(Cell.source("return 1", "typescript").digest)
  })
})

describe("Cell.FlowProjection", () => {
  const declaration: FlowBinding.Declared = {
    name: "inspect",
    description: "Inspect one value.",
    capabilities: [],
    effects: undefined
  }

  it("defaults a constructed projection to no input document", () => {
    const projection = new Cell.FlowProjection({
      name: "inspect",
      description: "Inspect one value.",
      capabilities: [],
      tier: "sealed",
      placement: Option.none()
    })

    expect(projection.input).toEqual(Option.none())
  })

  it("projects an inline input document", () => {
    const document = { type: "object", properties: { value: { type: "string" } } } as const
    const descriptor = FlowBinding.descriptorOf(declaration, { inputDocument: document })

    expect(Cell.project(descriptor).input).toEqual(Option.some(document))
  })

  it("projects input locators and absent schemas to none", () => {
    const descriptor = FlowBinding.descriptorOf(declaration)
    const inputs: ReadonlyArray<Descriptor.SchemaRef> = [
      descriptor.input,
      new Descriptor.SchemaRefMarkdownArgs(),
      new Descriptor.SchemaRefMarkdownOutput(),
      new Descriptor.SchemaRefNone()
    ]

    for (const input of inputs) {
      expect(Cell.project(new Descriptor.FlowDescriptor({ ...descriptor, input })).input).toEqual(Option.none())
    }
  })
})

describe("Cell.transition", () => {
  it("decodes each intent into its durable transition", () => {
    const kept = Cell.transition({
      intent: "continue",
      state: { seen: 2 },
      context: [{ role: "user", text: "two files" }]
    })
    expect(kept).toStrictEqual(
      new Cell.Settled({
        transition: new Cell.Continue({
          state: { seen: 2 },
          context: [new Cell.ContextEntry({ role: "user", text: "two files" })]
        })
      })
    )

    const done = Cell.transition({ intent: "complete", output: "answer" })
    expect(done._tag).toBe("settled")
    expect((done as Cell.Settled).transition).toStrictEqual(
      new Cell.Complete({ state: null, output: "answer", reason: undefined })
    )

    const parked = Cell.transition({ intent: "park", reason: "waiting-input", message: "need a choice" })
    expect((parked as Cell.Settled).transition._tag).toBe("park")
  })

  it("rejects anything that is not a transition, with instructions to fix it", () => {
    for (const value of [null, undefined, 42, "done", { intent: "explode" }, { intent: "complete" }]) {
      const outcome = Cell.transition(value)
      expect(outcome._tag).toBe("rejected")
      expect((outcome as Cell.Rejected).code).toBe("invalid_transition")
    }
  })
})
