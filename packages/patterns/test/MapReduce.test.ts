import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as MapReduce from "../src/MapReduce.ts"
import { PatternError } from "../src/PatternError.ts"

const step = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("MapReduce", () => {
  it("declares deterministic map and reduce phases", () => {
    const mapReduce = MapReduce.make({
      map: step,
      reduce: step,
      concurrency: 4,
      onEmpty: "reduce"
    })

    expect(Flow.isFlow(mapReduce)).toBe(true)
    expect(mapReduce.body?.({ shards: ["a", "b"] }).ast._tag).toBe("AndThen")
    const graph = Graph.build(mapReduce, { shards: ["a", "b", "c"] })
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(4)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
  })

  it("rejects invalid concurrency", () => {
    expect(() => MapReduce.make({ map: step, reduce: step, concurrency: 0, onEmpty: "fail" })).toThrow(PatternError)
  })
})
