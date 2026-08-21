/**
 * The journal shape of agent events projected by the executor.
 *
 * `AgentSession.test.ts` covers the events a live run produces. These
 * cases pin every payload field independently of the run that produced it.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"

const identity = new Cell.CallIdentity({
  session: "session-1",
  frame: 2,
  cell: "sha256:cell",
  ordinal: 1,
  declaration: "sha256:declaration",
  layers: ["layer-a"]
})

const call = new Cell.Call({
  flowName: "notes/save",
  input: { text: "Remember this." },
  capabilities: ["fs:write:notes/**"],
  effects: {
    reads: ["/notes/**"],
    writes: ["/notes/log.md"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  placement: Option.none(),
  identity
})

const cell = Cell.source("return { intent: 'complete', output: 'done' }")
const transition = new Cell.Complete({ state: null, output: "done", reason: "finished" })
const outcome = new Cell.Settled({ transition })
const reason = new EngineLike.SuspendReason({ code: "waiting-input", message: "Needs an answer" })
const request = new Permission.PermissionRequired({
  requestId: "permission-1",
  runId: "run-1",
  capability: Capability.make("fs:write", "notes/log.md"),
  tier: "irreversible",
  meta: { flowName: "notes/save" }
})
const assistant = ModelRequest.Message.assistant([
  ModelRequest.TextPart.make({ text: "First line." }),
  ModelRequest.ToolCallPart.make({ id: "call-0", name: "cell", arguments: "{}" }),
  ModelRequest.TextPart.make({ text: "Second line." })
])

describe("trace", () => {
  it.each(
    [
      [
        "model-retried",
        new AgentEvent.ModelRetried({
          eventType: "flows.harness.model-retried.v1",
          attempt: 2,
          code: "transport",
          delayMillis: 2_137
        }),
        {
          eventType: "control.agent.model-retried",
          // The delay is journaled with the attempt: every retry of one sealed
          // step is written when that step settles, so the run's own event
          // timestamps cannot tell a backoff from an immediate re-fire, and a
          // wave report reads the schedule off this payload instead.
          payload: { attempt: 2, code: "transport", delayMillis: 2_137 }
        }
      ],
      [
        "discipline-armed",
        new AgentEvent.DisciplineArmed({
          eventType: "flows.harness.discipline-armed.v1",
          readOnlyCap: 12,
          maxFrames: 100,
          approvalChannel: false,
          modelCallMs: 300_000,
          calls: 64,
          memoryBytes: 134_217_728,
          steps: 1_000,
          timeMs: 30_000,
          callMs: 120_000,
          totalMs: 900_000
        }),
        {
          eventType: "control.agent.discipline-armed",
          payload: {
            readOnlyCap: 12,
            maxFrames: 100,
            // False says nobody can answer a park, so the loop refuses one
            // rather than leaving the run waiting on an operator who is not
            // there. It is journaled before the first frame, like every other
            // armed budget.
            approvalChannel: false,
            // The model-call budget is journaled beside the cell budgets, and
            // `control.agent.model-settled` already carries `durationMillis`
            // per call, so a report can grade every call against the ceiling
            // the run armed without re-instrumenting anything.
            modelCallMs: 300_000,
            calls: 64,
            memoryBytes: 134_217_728,
            steps: 1_000,
            timeMs: 30_000,
            callMs: 120_000,
            totalMs: 900_000
          }
        }
      ],
      [
        "read-only-demanded",
        new AgentEvent.ReadOnlyDemanded({
          eventType: "flows.harness.read-only-demanded.v1",
          streak: 12,
          cap: 12,
          nextFrame: 13,
          nextAction: "write"
        }),
        {
          eventType: "control.agent.read-only-demanded",
          payload: { streak: 12, cap: 12, nextFrame: 13, nextAction: "write" }
        }
      ],
      [
        "turn-opened",
        new AgentEvent.TurnOpened({
          eventType: "flows.harness.turn-opened.v1",
          seat: "anthropic:test-model",
          modelParams: ModelRequest.GenerationParams.make({ temperature: 0 }),
          activeToolNames: ["cell"],
          contextDigest: "sha256:context"
        }),
        {
          eventType: "control.agent.turn-opened",
          payload: { seat: "anthropic:test-model", contextDigest: "sha256:context" }
        }
      ],
      [
        "model-settled",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: assistant,
          usage: ModelEvent.Usage.make({ inputTokens: 12, outputTokens: 3 }),
          durationMillis: 1_250
        }),
        {
          eventType: "control.agent.model-settled",
          payload: {
            text: "First line.\nSecond line.",
            usage: { inputTokens: 12, outputTokens: 3 },
            durationMillis: 1_250
          }
        }
      ],
      [
        "cell-produced",
        new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell }),
        {
          eventType: "control.agent.cell-produced",
          payload: { language: cell.language, digest: cell.digest, text: cell.text }
        }
      ],
      [
        "cell-call-started",
        new AgentEvent.CellCallStarted({ eventType: "flows.harness.cell-call-started.v1", call }),
        {
          eventType: "control.agent.cell-call-started",
          payload: { flowName: "notes/save", input: { text: "Remember this." } }
        }
      ],
      [
        "cell-call-settled",
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: "notes/save",
          identity,
          result: new Cell.CallResult({ outcome: "failure", value: null, message: "The note was locked" })
        }),
        {
          eventType: "control.agent.cell-call-settled",
          payload: {
            flowName: "notes/save",
            outcome: "failure",
            message: "The note was locked",
            value: null
          }
        }
      ],
      [
        "cell-settled",
        new AgentEvent.CellSettled({ eventType: "flows.harness.cell-settled.v1", cell: cell.digest, outcome }),
        { eventType: "control.agent.cell-settled", payload: { outcome } }
      ],
      [
        "transition-applied",
        new AgentEvent.TransitionApplied({
          eventType: "flows.harness.transition-applied.v1",
          transition
        }),
        { eventType: "control.agent.transition-applied", payload: { transition } }
      ],
      [
        "suspended",
        new AgentEvent.Suspended({ eventType: "flows.harness.suspended.v1", reason }),
        { eventType: "control.agent.suspended", payload: { reason } }
      ],
      [
        "compaction-settled",
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "sha256:prefix",
          summary: ModelRequest.Message.assistant("Six frames of edits, summarised.")
        }),
        {
          eventType: "control.agent.compaction-settled",
          payload: { replacedPrefixDigest: "sha256:prefix" }
        }
      ],
      [
        "turn-closed",
        new AgentEvent.TurnClosed({
          eventType: "flows.harness.turn-closed.v1",
          stopReason: "tool-calls",
          outcome: "continue"
        }),
        {
          eventType: "control.agent.turn-closed",
          payload: { stopReason: "tool-calls", outcome: "continue" }
        }
      ],
      [
        "permission-required",
        new AgentEvent.PermissionRequired({ eventType: "flows.harness.permission-required.v1", request }),
        { eventType: "control.agent.permission-required", payload: { request } }
      ],
      [
        "aborted",
        new AgentEvent.Aborted({
          eventType: "flows.harness.aborted.v1",
          reason: "frame ceiling reached"
        }),
        {
          eventType: "control.agent.aborted",
          payload: { reason: "frame ceiling reached" }
        }
      ],
      [
        "resolved",
        new AgentEvent.Resolved({ eventType: "flows.harness.resolved.v1", message: assistant }),
        { eventType: "control.agent.resolved", payload: { text: "First line.\nSecond line." } }
      ]
    ] satisfies ReadonlyArray<readonly [string, AgentEvent.AgentEvent, unknown]>
  )(
    "projects %s with its durable payload",
    (_name, event, expected) => {
      expect(AgentSession.trace(event)).toEqual(expected)
    }
  )

  it("journals no model delta", () => {
    expect(
      AgentSession.trace(
        new AgentEvent.ModelDelta({
          eventType: "flows.harness.model-delta.v1",
          delta: { type: "text-delta", id: "text-0", text: "par" }
        })
      )
    ).toBeUndefined()
  })
})
