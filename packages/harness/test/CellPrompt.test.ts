import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellPrompt from "../src/internal/cellPrompt.ts"

const projection = (
  name: string,
  input: Option.Option<Schema.Json>,
  overrides: {
    readonly capabilities?: ReadonlyArray<string>
    readonly tier?: Cell.FlowProjection["tier"]
    readonly description?: string
  } = {}
): Cell.FlowProjection =>
  new Cell.FlowProjection({
    name,
    description: overrides.description ?? `Call ${name}.`,
    capabilities: overrides.capabilities ?? [],
    tier: overrides.tier ?? "sealed",
    placement: Option.none(),
    input
  })

const catalogOf = (flows: Readonly<Record<string, Cell.FlowProjection>>) =>
  CellPrompt.make(flows).find((section) => section.id === "cell-catalog")?.text

describe("cellPrompt", () => {
  it("renders an inline input document only beneath the projection that carries it", () => {
    const document = { type: "object", required: ["path"] } as const
    const sections = CellPrompt.make({
      documented: projection("documented", Option.some(document)),
      opaque: projection("opaque", Option.none())
    })
    const catalog = sections.find((section) => section.id === "cell-catalog")

    expect(catalog?.text).toBe(
      `Flows callable with ctx.call in this frame:
- documented (sealed): Call documented.
  input: ${JSON.stringify(document)}
- opaque (sealed): Call opaque.`
    )
  })

  it("tells a cell with no callable flows to complete or park", () => {
    expect(catalogOf({})).toBe(
      "No flows are callable in this run. Complete or park; ctx.call has nothing to reach."
    )
  })

  it("renders the single-flow catalog with no separator", () => {
    expect(catalogOf({ only: projection("only", Option.none()) })).toBe(
      `Flows callable with ctx.call in this frame:
- only (sealed): Call only.`
    )
  })

  it("lists capabilities sorted, and omits the clause entirely when a flow declares none", () => {
    expect(
      catalogOf({
        bare: projection("bare", Option.none()),
        guarded: projection("guarded", Option.none(), { capabilities: ["write", "net", "read"] })
      })
    ).toBe(
      `Flows callable with ctx.call in this frame:
- bare (sealed): Call bare.
- guarded (sealed) capabilities=net,read,write: Call guarded.`
    )
  })

  it("renders a single capability without a trailing separator", () => {
    expect(catalogOf({ one: projection("one", Option.none(), { capabilities: ["read"] }) })).toContain(
      "- one (sealed) capabilities=read: Call one."
    )
  })

  it("names each flow's declared tier", () => {
    expect(
      catalogOf({
        a: projection("a", Option.none(), { tier: "sealed" }),
        b: projection("b", Option.none(), { tier: "compensable" }),
        c: projection("c", Option.none(), { tier: "irreversible" })
      })
    ).toBe(
      `Flows callable with ctx.call in this frame:
- a (sealed): Call a.
- b (compensable): Call b.
- c (irreversible): Call c.`
    )
  })

  it("orders the catalog by flow name, not by record insertion order", () => {
    const catalog = catalogOf({
      zebra: projection("zebra", Option.none()),
      alpha: projection("alpha", Option.none())
    })
    expect(catalog?.indexOf("- alpha")).toBeLessThan(catalog?.indexOf("- zebra") ?? -1)
  })

  it("keys the catalog on the record, not on the projection's own name", () => {
    // The heading is the record key, which is how the run addresses the call.
    expect(catalogOf({ "fs/list": projection("ignored", Option.none()) })).toContain("- fs/list (sealed)")
  })

  it("renders an empty inline input document as an empty object", () => {
    expect(catalogOf({ any: projection("any", Option.some({})) })).toContain("  input: {}")
  })

  it("renders a non-object inline input document verbatim", () => {
    expect(catalogOf({ any: projection("any", Option.some(null)) })).toContain("  input: null")
  })

  it("always returns the contract section first and the catalog second", () => {
    const sections = CellPrompt.make({})
    expect(sections.map((section) => section.id)).toEqual(["cell-contract", "cell-catalog"])
  })

  it("digests each section over its id and text", () => {
    const sections = CellPrompt.make({ only: projection("only", Option.none()) })
    for (const section of sections) {
      expect(section.digest).toBe(
        Digest.digest(CanonicalJson.stringify({ id: section.id, text: section.text }))
      )
    }
    // Two sections with different ids never collide on the same digest.
    expect(sections[0]?.digest).not.toBe(sections[1]?.digest)
  })

  it("keeps the contract byte-identical while the catalog changes", () => {
    const empty = CellPrompt.make({})
    const populated = CellPrompt.make({ only: projection("only", Option.none()) })
    expect(populated[0]).toEqual(empty[0])
    expect(populated[1]?.digest).not.toBe(empty[1]?.digest)
  })

  it("renders the same sections for the same flows", () => {
    const flows = { only: projection("only", Option.some({ type: "object" })) }
    expect(CellPrompt.make(flows)).toEqual(CellPrompt.make(flows))
  })

  it("teaches the cell-block rule and the three transition intents", () => {
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("fenced block tagged `cell`")
    for (const intent of ["intent: \"continue\"", "intent: \"complete\"", "intent: \"park\""]) {
      expect(contract).toContain(intent)
    }
  })

  it("teaches that several cell blocks are one program and that the first return ends it", () => {
    // The contract has to say this because the harness now runs every block:
    // a model that batches must declare each name once, and a model that
    // returns early must know the blocks after that return do not run.
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("concatenated in order and run as ONE program in ONE frame")
    expect(contract).toContain("the first `return` ends the frame")
  })

  it("teaches the state projection and the automatic call ledger", () => {
    // Both close the same leak: a model that cannot see what it already knows
    // spends a whole frame moving bytes it already owns.
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("name the keys your next frame must SEE")
    expect(contract).toContain("never spend a frame echoing state into `context`")
    expect(contract).toContain("Every call this run has settled is listed for you")
  })

  it("teaches canonical regression evidence and language-aware post-edit diagnostics", () => {
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("Before the first write")
    expect(contract).toContain("state.verification")
    expect(contract).toContain("language-aware per-file diagnostics")
    expect(contract).toContain("undefined-name")
  })

  it("teaches that a check is evidence only once it has failed for the right reason", () => {
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("FOR THE RIGHT REASON")
    // Naming the class is the point: a probe that fails because it named
    // something absent reads the same before and after a correct fix.
    expect(contract).toContain("does not exist reproduces nothing")
    expect(contract).toContain("invalidProbe")
    expect(contract).toContain("before you edit anything")
  })

  it("teaches that a file is restored with git, never through captured stdout", () => {
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("a result flagged truncated is a fragment")
    expect(contract).toContain("git checkout or git restore")
    expect(contract).toContain("never route file content through captured stdout")
    // The refusal is stated, so the first frame that tries it already knows why.
    expect(contract).toContain("a write of bytes a call returned truncated is refused")
  })

  it("teaches that one cell can baseline, edit, and re-check without spending three frames", () => {
    const contract = CellPrompt.make({})[0]?.text ?? ""
    expect(contract).toContain("ONE cell may run the baseline check")
    expect(contract).toContain("a cell can make many calls")
  })
})
