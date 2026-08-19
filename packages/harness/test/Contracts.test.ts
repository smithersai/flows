import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Plan from "../src/Plan.ts"

const assistantMessage = ModelRequest.Message.assistant("done", { stopReason: "stop" })
const child = new Plan.Child({
  flowName: "read-pr",
  callId: "call-1",
  args: { number: 42 },
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
const batch = new Plan.Batch({ children: [child] })
const permissionRequest = new Permission.PermissionRequired({
  requestId: "permission-1",
  capability: new Capability.Capability({
    action: "fs:read",
    resource: "/workspace"
  }),
  tier: "sealed",
  meta: {}
})

describe("AgentEvent", () => {
  it("round-trips every stable event variant", () => {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: "sdk:model",
        modelParams: ModelRequest.GenerationParams.make({ reasoningEffort: "low" }),
        activeToolNames: ["flow"],
        contextDigest: "context-digest"
      }),
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: ModelEvent.ModelEvent.TextDelta({
          type: "text-delta",
          id: "text-1",
          text: "hello"
        })
      }),
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: assistantMessage,
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
      }),
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "prefix-digest",
        summary: assistantMessage
      }),
      new AgentEvent.SteeringDrained({
        eventType: "flows.harness.steering-drained.v1",
        messages: [ModelRequest.Message.user("continue")]
      }),
      new AgentEvent.TurnClosed({
        eventType: "flows.harness.turn-closed.v1",
        stopReason: "tool-calls",
        outcome: "continue"
      }),
      new AgentEvent.PermissionRequired({
        eventType: "flows.harness.permission-required.v1",
        request: permissionRequest
      }),
      new AgentEvent.Aborted({
        eventType: "flows.harness.aborted.v1",
        reason: "interrupted"
      }),
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: assistantMessage
      })
    ]

    for (const event of events) {
      expect(
        Schema.decodeUnknownSync(AgentEvent.AgentEvent)(
          Schema.encodeSync(AgentEvent.AgentEvent)(event)
        )
      ).toEqual(event)
    }
  })
})

describe("HarnessError", () => {
  it("constructs every stable code", () => {
    const codes = [
      "assembly_failed",
      "render_failed",
      "projection_failed",
      "model_failed",
      "elaboration_failed",
      "engine_failed",
      "invalid_step",
      "lazy_tool_prompt_metadata",
      "aborted",
      "suspended",
      "adapter_spawn_failed",
      "adapter_quota_exhausted",
      "adapter_session_lost",
      "adapter_config_invalid",
      "adapter_auth_failed",
      "adapter_protocol_error",
      "adapter_binary_missing",
      "adapter_unsupported",
      "adapter_structured_output_failed",
      "unknown"
    ] as const

    for (const code of codes) {
      const error = new HarnessError({ code, message: code })
      expect(error.code).toBe(code)
      expect(error._tag).toBe("/harness/HarnessError")
    }
  })
})

describe("EngineLike", () => {
  it("resolves its noop layer and fails unavailable operations cleanly", async () => {
    const service = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* EngineLike.EngineLike
      }).pipe(Effect.provide(EngineLike.layerNoop()))
    )
    const request = ModelRequest.ModelRequest.make({
      modelId: "model",
      system: [],
      messages: [],
      tools: [],
      params: {}
    })

    const sealExit = await Effect.runPromiseExit(
      Stream.runDrain(service.sealStep({
        request,
        keyMaterial: {
          version: "flows/key-material/v1",
          kind: "sealed",
          body: request,
          inputs: [{ _tag: "Literal", value: { contextDigest: "context-digest" } }],
          layers: ["model:test"],
          capabilities: ["model:call:provider/model"],
          effects: undefined,
          placement: undefined
        }
      }))
    )
    const spliceExit = await Effect.runPromiseExit(Stream.runDrain(service.splice(batch)))
    const suspendExit = await Effect.runPromiseExit(
      service.suspend(
        new EngineLike.SuspendReason({
          code: "engine",
          message: "test"
        })
      )
    )

    expect(sealExit._tag).toBe("Failure")
    expect(spliceExit._tag).toBe("Failure")
    expect(suspendExit._tag).toBe("Failure")
  })
})
