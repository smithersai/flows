import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellPrompt from "../src/internal/cellPrompt.ts"

const projection = (
  name: string,
  input: Option.Option<Schema.Json>
): Cell.FlowProjection =>
  new Cell.FlowProjection({
    name,
    description: `Call ${name}.`,
    capabilities: [],
    tier: "sealed",
    placement: Option.none(),
    input
  })

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
})
