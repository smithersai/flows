import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Forensics from "../src/Forensics.ts"

/** Builds one watch delta with the fields the projections read. */
const event = (
  kind: string,
  payload: unknown,
  occurredAt = 1_000
): ControlSchema.ControlEvent => ({
  sequence: occurredAt,
  kind,
  runId: "run-1" as ControlSchema.ControlEvent["runId"],
  occurredAt,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const turn = (at: number) => event("control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", at }, at)

const call = (flowName: string, input: unknown, at: number) =>
  event("control.agent.cell-call-started", { flowName, input, at }, at)

const settledCall = (flowName: string, at: number) =>
  event("control.agent.cell-call-settled", { flowName, outcome: "success", value: null, at }, at)

const refusedCall = (message: string, at: number) =>
  event("control.agent.cell-call-settled", { flowName: "bash", outcome: "failure", message, at }, at)

describe("Forensics.digest", () => {
  it("counts turns, calls, refusals, duplicates, and edits", () => {
    const d = Forensics.digest([
      event("control.run.running", { runId: "run-1", status: "running" }, 0),
      turn(1_000),
      call("bash", { command: "ls" }, 2_000),
      refusedCall("Flow bash failed: refused once", 3_000),
      turn(4_000),
      call("bash", { command: "ls" }, 5_000),
      settledCall("bash", 6_000),
      call("edit", { path: "a.py" }, 7_000),
      settledCall("edit", 8_000),
      event("control.run.completed", { runId: "run-1", status: "completed" }, 9_000)
    ])
    expect(d.turns).toBe(2)
    expect(d.calls).toBe(3)
    expect(d.callsFailed).toBe(1)
    // The second `bash {command:"ls"}` is byte-identical to the first.
    expect(d.duplicateCalls).toBe(1)
    expect(d.editsAttempted).toBe(1)
    expect(d.editsSucceeded).toBe(1)
    expect(d.status).toBe("completed")
    expect(d.refusals).toEqual([{ message: "Flow bash failed: refused once", count: 1 }])
    expect(d.flows[0]).toEqual(["bash", 2])
  })

  it("sums usage tokens and keeps the recorded failure cause", () => {
    const d = Forensics.digest([
      turn(0),
      event("control.agent.model-settled", { text: "x", usage: { inputTokens: 100, outputTokens: 7 } }, 1),
      event("control.agent.model-settled", { text: "y", usage: { inputTokens: 50, outputTokens: 3 } }, 2),
      event("control.run.failed", { runId: "run-1", status: "failed", cause: "boom\nstack" }, 3)
    ])
    expect(d.inputTokens).toBe(150)
    expect(d.outputTokens).toBe(10)
    expect(d.status).toBe("failed")
    expect(d.cause).toBe("boom\nstack")
  })

  it("prefers the payload's own occurrence stamp over journal admission time", () => {
    const d = Forensics.digest([
      event("control.agent.turn-opened", { seat: "s", at: 10 }, 5_000),
      event("control.agent.resolved", { text: "done", at: 4_010 }, 5_000)
    ])
    expect(d.startedAt).toBe(10)
    expect(d.endedAt).toBe(4_010)
  })

  it("captures the parked ask and its approval payload", () => {
    const d = Forensics.digest([
      event("control.approval.requested", {
        question: "May I?",
        payload: { idempotencyKey: "approve:x", scope: "run" }
      }, 1),
      event("control.run.waiting-approval", { runId: "run-1", status: "waiting-approval" }, 2)
    ])
    expect(d.parkedQuestion).toBe("May I?")
    expect(d.parkedApproval).toBe(JSON.stringify({ idempotencyKey: "approve:x", scope: "run" }))
  })

  it("is total over malformed payloads", () => {
    const d = Forensics.digest([
      event("control.agent.model-settled", null, 1),
      event("control.agent.cell-call-started", "not-an-object", 2),
      event("control.agent.cell-call-settled", 7, 3)
    ])
    expect(d.calls).toBe(1)
    expect(d.flows).toEqual([["?", 1]])
    expect(d.inputTokens).toBe(0)
  })
})

describe("Forensics.renderDiagnosis", () => {
  it("names the failure cause in the verdict", () => {
    const d = Forensics.digest([
      turn(0),
      event("control.run.failed", { runId: "run-1", status: "failed", cause: "TransportError: gone" }, 1)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1", flowId: "fix" }, d)
    expect(card).toContain("Verdict   failed — TransportError: gone")
    expect(card).toContain("run-1 · fix")
    expect(card).toContain("Next      flows logs run-1")
  })

  it("calls out a completed run that never attempted an edit", () => {
    const d = Forensics.digest([
      turn(0),
      call("read", { path: "a" }, 1),
      settledCall("read", 2),
      event("control.run.completed", { runId: "run-1", status: "completed" }, 3)
    ])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d))
      .toContain("completed — but 0 of 1 calls attempted an edit")
  })

  it("prints the exact unblock command for a parked run", () => {
    const d = Forensics.digest([
      event("control.approval.requested", { question: "Q", payload: { k: 1 } }, 1),
      event("control.run.waiting-approval", { runId: "run-1", status: "waiting-approval" }, 2)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card).toContain("waiting-approval — asks: Q")
    expect(card).toContain(`Unblock   flows approve '{"k":1}' --scope run && flows run --resume run-1`)
  })

  it("lists the top refusals with counts, largest first", () => {
    const d = Forensics.digest([
      turn(0),
      refusedCall("first refusal", 1),
      refusedCall("second refusal", 2),
      refusedCall("second refusal", 3)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card).toContain("Refusals  2× second refusal")
    expect(card).toContain("1× first refusal")
  })
})

describe("Forensics.renderTranscript", () => {
  it("renders a turn header and one line per event", () => {
    const text = Forensics.renderTranscript([
      event("control.run.running", { runId: "run-1", status: "running", at: 0 }, 0),
      turn(1_000),
      event("control.agent.model-settled", {
        text: "```cell\nreturn 1\n```",
        usage: { inputTokens: 9, outputTokens: 2 },
        at: 2_000
      }, 2_000),
      call("bash", { command: "echo hi" }, 3_000),
      refusedCall("Flow bash failed: nope", 4_000),
      event("control.agent.transition-applied", {
        transition: { _tag: "complete", state: {}, output: "done" },
        at: 5_000
      }, 5_000),
      event("control.run.completed", { runId: "run-1", status: "completed", at: 6_000 }, 6_000)
    ])
    expect(text).toContain("run-1 · completed")
    expect(text).toContain("=== turn 1 · openai:gpt-5.6-sol ===")
    expect(text).toContain("call    bash {\"command\":\"echo hi\"}")
    expect(text).toContain("-> FAIL Flow bash failed: nope")
    expect(text).toContain("complete done")
    expect(text).toContain("[+00:06] run.completed")
  })

  it("renders the empty journal as a sentence, not a crash", () => {
    expect(Forensics.renderTranscript([])).toBe("No events.")
  })
})
