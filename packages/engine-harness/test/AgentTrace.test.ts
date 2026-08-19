/**
 * The journal shape of one agent event.
 *
 * `HarnessExecutor.test.ts` covers the events a live run produces. The cases
 * here are the ones a run does not reach on its own: a compaction, an abort,
 * and a settlement whose message carries more than text.
 */
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { describe, expect, it } from "vitest"
import * as HarnessExecutor from "../src/HarnessExecutor.ts"

describe("trace", () => {
  it("names the replaced prefix when a compaction settles", () => {
    const projected = HarnessExecutor.trace(
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "sha256:prefix",
        summary: ModelRequest.Message.assistant("Six frames of edits, summarised.")
      })
    )
    expect(projected).toEqual({
      eventType: "control.agent.compaction-settled",
      payload: { replacedPrefixDigest: "sha256:prefix" }
    })
  })

  it("carries the reason when a run aborts", () => {
    const projected = HarnessExecutor.trace(
      new AgentEvent.Aborted({ eventType: "flows.harness.aborted.v1", reason: "frame ceiling reached" })
    )
    expect(projected).toEqual({
      eventType: "control.agent.aborted",
      payload: { reason: "frame ceiling reached" }
    })
  })

  it("keeps the text of a settlement and drops the tool call beside it", () => {
    const projected = HarnessExecutor.trace(
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant([
          ModelRequest.TextPart.make({ text: "Applying the patch." }),
          ModelRequest.ToolCallPart.make({ id: "call-0", name: "cell", arguments: "{}" })
        ]),
        usage: ModelEvent.Usage.make({ inputTokens: 12, outputTokens: 3 })
      })
    )
    expect(projected).toEqual({
      eventType: "control.agent.model-settled",
      payload: { text: "Applying the patch.", usage: { inputTokens: 12, outputTokens: 3 } }
    })
  })

  it("journals no model delta", () => {
    expect(
      HarnessExecutor.trace(
        new AgentEvent.ModelDelta({
          eventType: "flows.harness.model-delta.v1",
          delta: { type: "text-delta", id: "text-0", text: "par" }
        })
      )
    ).toBeUndefined()
  })
})
