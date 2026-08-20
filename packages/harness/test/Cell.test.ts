import * as Descriptor from "@smthrs/registry/Descriptor"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as FlowBinding from "../src/FlowBinding.ts"
import { rejectedCell, rejectedCellNames } from "./fixtures/rejectedCells.ts"

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
    expect(Result.getOrThrow(Cell.extract(fenced("typescript", "return 1"))).language).toBe("typescript")
  })

  it("reads the fence tag case-insensitively and past decoration the model adds", () => {
    for (const info of ["CELL", "  cell  ", "js title=plan.js", "linenums ts", "Cell showLineNumbers"]) {
      const extracted = Cell.extract(fenced(info, "return 1"))
      expect(extracted._tag, info).toBe("Success")
    }
    expect(Result.getOrThrow(Cell.extract(fenced("linenums ts", "return 1"))).language).toBe("typescript")
  })

  it("ignores a fence with no tag at all", () => {
    // An untagged fence is the shape a model reaches for when it is quoting
    // output, not committing to a cell.
    const extracted = Cell.extract(fenced("", "return 1"))
    expect(extracted._tag).toBe("Failure")
    expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code).toBe("no_cell")
  })

  it("ignores a fence tagged as something other than a cell", () => {
    for (const info of ["python", "json", "diff", "sh"]) {
      const extracted = Cell.extract(fenced(info, "return 1"))
      expect(extracted._tag, info).toBe("Failure")
      expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code, info).toBe("no_cell")
    }
  })

  it("skips unrecognized fences on the way to the last cell fence", () => {
    const text = [
      fenced("cell", "return \"first\""),
      fenced("json", "{ \"not\": \"a cell\" }"),
      fenced("", "untagged"),
      fenced("cell", "return \"last\""),
      fenced("text", "trailing prose block")
    ].join("\n\n")

    const extracted = Result.getOrThrow(Cell.extract(text))
    expect(extracted.text).toBe("return \"last\"")
    expect(extracted.language).toBe("javascript")
  })

  it("keeps the language of the last recognized fence when a later one is unrecognized", () => {
    const text = [fenced("ts", "return 1"), fenced("python", "print(1)")].join("\n\n")
    expect(Result.getOrThrow(Cell.extract(text)).language).toBe("typescript")
  })

  it("accepts an empty cell body as an empty cell", () => {
    const extracted = Result.getOrThrow(Cell.extract("```cell\n```"))
    expect(extracted.text).toBe("")
    expect(extracted.digest).toBe(Cell.source("").digest)
  })

  it("finds no cell in an unterminated fence", () => {
    const extracted = Cell.extract("```cell\nreturn { intent: \"complete\", output: \"x\" }")
    expect(extracted._tag).toBe("Failure")
    expect((extracted as Result.Failure<never, Cell.Rejected>).failure.code).toBe("no_cell")
  })

  it("finds no cell in an empty response", () => {
    expect((Cell.extract("") as Result.Failure<never, Cell.Rejected>).failure.code).toBe("no_cell")
  })

  it("rescans from the start of every response, so one extraction cannot skip the next", () => {
    // The fence pattern is a module-level global regexp, which carries a
    // cursor between calls unless it is reset.
    const text = fenced("cell", "return \"repeatable\"")
    expect(Result.getOrThrow(Cell.extract(text)).text).toBe("return \"repeatable\"")
    expect(Result.getOrThrow(Cell.extract(text)).text).toBe("return \"repeatable\"")
  })

  it("reports a missing cell as a correctable rejection, not a failure", () => {
    const extracted = Cell.extract("I think we should stop here.")
    expect(extracted._tag).toBe("Failure")
    const rejection = (extracted as Result.Failure<never, Cell.Rejected>).failure
    expect(rejection.code).toBe("no_cell")
    expect(rejection.message).toContain("fenced ```cell block")
  })

  it("reads text and leaves every judgement about syntax to the compiler", () => {
    // Extraction used to match `import` against the raw source, which read a
    // quoted Python import as a module import. Whether a cell uses module
    // syntax is `Sandbox.compile`'s question, answered by parsing.
    for (
      const body of [
        "import { readFile } from \"node:fs\"\nreturn null",
        "const important = ctx.flows\nreturn { intent: \"park\" }"
      ]
    ) {
      expect(Cell.extract(fenced("cell", body))._tag, body).toBe("Success")
    }
  })
})

describe("Cell.extract on the frames one benchmark wave rejected", () => {
  // Verbatim final cells from SWE-bench wave 5, each recorded in its run's
  // journal beside the `imports_forbidden` rejection it drew. Every one of them
  // only mentions an import inside a bash command or a grep pattern, and the
  // sphinx cell is that instance's opening frame, so the run began by spending
  // a turn on a rule it had not broken.
  for (const name of rejectedCellNames) {
    it(`extracts the cell ${name} carried`, () => {
      const extracted = Cell.extract(rejectedCell(name))
      expect(extracted._tag).toBe("Success")
      expect(Result.getOrThrow(extracted).text).toContain("ctx.call")
    })
  }
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
          context: [new Cell.ContextEntry({ role: "user", text: "two files" })],
          justification: undefined
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

  it("reads an absent state as null and keeps an explicit one, for every intent", () => {
    const absent = [
      Cell.transition({ intent: "continue", context: [] }),
      Cell.transition({ intent: "complete", output: "" }),
      Cell.transition({ intent: "park", reason: "waiting-input", message: "" })
    ]
    expect(absent.map((outcome) => (outcome as Cell.Settled).transition.state)).toEqual([null, null, null])

    const explicit = Cell.transition({ intent: "continue", state: null, context: [] })
    expect((explicit as Cell.Settled).transition.state).toBe(null)

    const nested = Cell.transition({ intent: "complete", state: { plan: ["a", { done: true }] }, output: "x" })
    expect((nested as Cell.Settled).transition.state).toEqual({ plan: ["a", { done: true }] })
  })

  it("keeps the optional fields each intent carries, and leaves the absent ones undefined", () => {
    const justified = Cell.transition({
      intent: "continue",
      context: [{ role: "assistant", text: "still reading" }],
      justification: "the fix is not located yet"
    })
    expect((justified as Cell.Settled).transition).toStrictEqual(
      new Cell.Continue({
        state: null,
        context: [new Cell.ContextEntry({ role: "assistant", text: "still reading" })],
        justification: "the fix is not located yet"
      })
    )

    const reasoned = Cell.transition({
      intent: "complete",
      output: "patched",
      reason: "tests pass"
    })
    expect((reasoned as Cell.Settled).transition).toStrictEqual(
      new Cell.Complete({
        state: null,
        output: "patched",
        reason: "tests pass"
      })
    )
  })

  it("accepts every park reason and refuses one that is not declared", () => {
    for (const reason of ["waiting-input", "waiting-event", "waiting-quota"] as const) {
      const outcome = Cell.transition({ intent: "park", reason, message: "held" })
      expect((outcome as Cell.Settled).transition).toStrictEqual(
        new Cell.Park({ state: null, reason, message: "held" })
      )
    }

    expect(Cell.transition({ intent: "park", reason: "waiting-forever", message: "held" })._tag).toBe("rejected")
  })

  it("accepts the empty edges of every string and collection it carries", () => {
    expect((Cell.transition({ intent: "complete", output: "" }) as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: ""
    })
    expect((Cell.transition({ intent: "continue", context: [] }) as Cell.Settled).transition).toMatchObject({
      _tag: "continue",
      context: []
    })
    expect((Cell.transition({ intent: "park", reason: "waiting-input", message: "" }) as Cell.Settled).transition)
      .toMatchObject({ _tag: "park", message: "" })
  })

  it("refuses a context entry whose role or text is not what the contract declares", () => {
    for (
      const context of [
        [{ role: "system", text: "no" }],
        [{ role: "user" }],
        [{ role: "user", text: 42 }],
        ["plain string"]
      ]
    ) {
      const outcome = Cell.transition({ intent: "continue", context })
      expect(outcome._tag, JSON.stringify(context)).toBe("rejected")
    }
  })
})
