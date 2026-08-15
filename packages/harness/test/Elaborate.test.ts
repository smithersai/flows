import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Elaborate from "../src/Elaborate.ts"

const input = Schema.Struct({ value: Schema.String })
const declaration = (
  flowName: string
): Elaborate.FlowDeclaration => ({
  flowName,
  input,
  capabilities: ["fs:read:/workspace/**"],
  effects: {
    reads: ["/workspace/**"],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  },
  placement: Option.some("local")
})
const catalog: Elaborate.Catalog = {
  tools: {
    alpha: declaration("alpha-flow"),
    serial: declaration("serial-flow")
  },
  creatorFlows: {
    creator: declaration("creator-flow")
  }
}

const message = (calls: ReadonlyArray<ModelRequest.ToolCallPart>, stopReason: ModelRequest.StopReason = "tool-calls") =>
  ModelRequest.Message.assistant(calls, { stopReason })

describe("Elaborate", () => {
  it("makes child nodes in call order without computing keys", () => {
    const result = Elaborate.elaborate(
      message([
        ModelRequest.ToolCallPart.make({ id: "a", name: "alpha", arguments: "{\"value\":\"one\"}" }),
        ModelRequest.ToolCallPart.make({ id: "b", name: "alpha", arguments: "{\"value\":\"two\"}" })
      ]),
      catalog
    )
    expect(result.orderedCallIds).toEqual(["a", "b"])
    expect(result.errorResults).toEqual([])
    expect(result.batch).toEqual({
      children: [
        {
          flowName: "alpha-flow",
          callId: "a",
          args: { value: "one" },
          capabilities: ["fs:read:/workspace/**"],
          effects: {
            reads: ["/workspace/**"],
            writes: [],
            mode: "hermetic",
            onConflict: "serialize",
            tier: "sealed"
          },
          placement: Option.some("local")
        },
        {
          flowName: "alpha-flow",
          callId: "b",
          args: { value: "two" },
          capabilities: ["fs:read:/workspace/**"],
          effects: {
            reads: ["/workspace/**"],
            writes: [],
            mode: "hermetic",
            onConflict: "serialize",
            tier: "sealed"
          },
          placement: Option.some("local")
        }
      ]
    })
  })

  it("returns an error result for unknown tools without producing a node", () => {
    const result = Elaborate.elaborate(
      message([ModelRequest.ToolCallPart.make({ id: "unknown", name: "missing", arguments: "{}" })]),
      catalog
    )
    expect(result.batch).toBeUndefined()
    expect(result.errorResults.map((result) => result.toolCallId)).toEqual(["unknown"])
  })

  it("returns error results for malformed JSON and failed validation", () => {
    const result = Elaborate.elaborate(
      message([
        ModelRequest.ToolCallPart.make({ id: "json", name: "alpha", arguments: "{" }),
        ModelRequest.ToolCallPart.make({ id: "schema", name: "alpha", arguments: "{}" })
      ]),
      catalog
    )
    expect(result.batch).toBeUndefined()
    expect(result.errorResults.map((result) => result.toolCallId)).toEqual(["json", "schema"])
  })

  it("retains source order for correlation without adding sequencing metadata", () => {
    const result = Elaborate.elaborate(
      message([
        ModelRequest.ToolCallPart.make({ id: "a", name: "alpha", arguments: "{\"value\":\"one\"}" }),
        ModelRequest.ToolCallPart.make({ id: "s", name: "serial", arguments: "{\"value\":\"two\"}" })
      ]),
      catalog
    )
    expect(result.batch?.children.map((child) => child.callId)).toEqual(["a", "s"])
    expect(result.batch).not.toHaveProperty("mode")
  })

  it("rejects every tool call after a length stop", () => {
    const result = Elaborate.elaborate(
      message(
        [
          ModelRequest.ToolCallPart.make({ id: "a", name: "alpha", arguments: "{\"value\":\"one\"}" }),
          ModelRequest.ToolCallPart.make({ id: "b", name: "missing", arguments: "{}" })
        ],
        "length"
      ),
      catalog
    )
    expect(result.batch).toBeUndefined()
    expect(result.errorResults.map((result) => result.toolCallId)).toEqual(["a", "b"])
  })

  it("routes flow run and create actions", () => {
    const result = Elaborate.elaborate(
      message([
        ModelRequest.ToolCallPart.make({
          id: "run",
          name: "flow",
          arguments: "{\"action\":{\"type\":\"run\",\"flow\":\"alpha\",\"input\":{\"value\":\"one\"}}}"
        }),
        ModelRequest.ToolCallPart.make({
          id: "create",
          name: "flow",
          arguments: "{\"action\":{\"type\":\"create\",\"creatorFlow\":\"creator\",\"input\":{\"value\":\"new\"}}}"
        })
      ]),
      catalog
    )
    expect(result.errorResults).toEqual([])
    expect(result.batch?.children.map((child) => [child.callId, child.flowName])).toEqual([
      ["run", "alpha-flow"],
      ["create", "creator-flow"]
    ])
  })
})
