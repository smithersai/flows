import { Effect, Layer, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { isControlError } from "../src/ControlClient.ts"
import { PlanDigestMismatch, RunNotFound, TransportError } from "../src/ControlError.ts"
import { ControlRpcs, layerNoopAuth } from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as TestControl from "../src/test/TestControl.ts"

const principal = { id: "server", kind: "test", stampedAt: 1 }

const layer = Layer.merge(ControlServer.layer, layerNoopAuth(principal)).pipe(
  Layer.provide(TestControl.layer({ principal: { id: principal.id, kind: principal.kind }, now: () => 1 }))
)

const makeClient = RpcTest.makeClient(ControlRpcs)
type ControlRpcClient = Effect.Success<typeof makeClient>

const client = <A, E>(
  effect: (client: ControlRpcClient) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const rpc = yield* makeClient
      return yield* effect(rpc)
    }).pipe(Effect.provide(layer))
  )

const plan = (rpc: ControlRpcClient) =>
  rpc.Plan({ flowId: "system/release", input: { release: true }, idempotencyKey: "plan" })

describe("ControlRpcs", () => {
  it("classifies owned failures through the control error schema union", () => {
    expect(isControlError(new RunNotFound({ runId: "missing" }))).toBe(true)
    expect(isControlError(new TransportError({ message: "offline", retryable: true }))).toBe(true)
    expect(isControlError(new Error("transport failure"))).toBe(false)
  })

  it("round-trips plan, approve, and list", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        const approval = yield* rpc.Approve({ ...card.approval, idempotencyKey: "approve" })
        const listed = yield* rpc.List({ _tag: "flows" })
        return { approval, listed }
      })
    ))

    expect(result.approval._tag).toBe("Accepted")
    expect(result.listed._tag).toBe("flows")
  })

  it("preserves domain failure tags", async () => {
    const error = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        return yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: "not-the-plan-digest",
          envelope: card.envelope,
          idempotencyKey: "run"
        }).pipe(Effect.flip)
      })
    ))

    expect(error).toBeInstanceOf(PlanDigestMismatch)
  })

  it("streams journal events and supports client interruption", async () => {
    const events = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        yield* rpc.Approve({ ...card.approval, idempotencyKey: "stream-approve" })
        const receipt = yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "start"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return []
        return yield* rpc.Watch({ runId: receipt.runId }).pipe(Stream.take(1), Stream.runCollect)
      })
    ))

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("control.run.accepted")
  })

  it("rejects malformed payloads before handlers and ignores caller principal fields", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const malformed = yield* Effect.exit(rpc.Plan({ flowId: 1, input: null } as never))
        const card = yield* plan(rpc)
        yield* rpc.Approve({
          ...card.approval,
          scope: "once",
          idempotencyKey: "auth",
          principal: { id: "attacker", kind: "attacker", stampedAt: 0 }
        } as never)
        return malformed
      })
    ))

    expect(result._tag).toBe("Failure")
  })
})
