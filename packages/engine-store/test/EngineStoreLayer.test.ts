import { FlowEngine } from "@smthrs/engine"
import { Activity, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { runPromise } from "./Sha256.ts"

const LayerFlow = Flow.make("EngineStoreLayer/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const otherOwner: Ownership.OwnerId = {
  hostId: "other-host",
  pid: 4242,
  nonce: "other-owner"
}

interface JjCall {
  readonly op: "snapshot" | "restore" | "diff"
  readonly argument: string
}

const recordingJj = (
  calls: Array<JjCall>,
  overrides: Partial<Jj.Jj> = {}
): Jj.Jj =>
  Jj.make({
    snapshot: (message) =>
      Effect.sync(() => {
        calls.push({ op: "snapshot", argument: message ?? "" })
        return { changeId: `change-${calls.length}` as never }
      }),
    restore: (changeId) =>
      Effect.sync(() => {
        calls.push({ op: "restore", argument: changeId as string })
      }),
    diff: (from, to) =>
      Effect.sync(() => {
        calls.push({ op: "diff", argument: `${from as string}->${to as string}` })
        return "diff-body"
      }),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed(""),
    ...overrides
  })

const baseLayers = (jj: Jj.Jj, state: DurableEngineState.Service) =>
  Layer.mergeAll(
    TestStores.layer(),
    StepBoundary.layerTest(),
    Layer.succeed(Jj.Jj, jj),
    Layer.succeed(DurableEngineState.DurableEngineState, state)
  )

describe("EngineStore.layer", () => {
  it("names opaque-handler fixtures and refuses accidental body interpretation", () => {
    expect(() => LayerFlow.body({})).toThrow("opaque-handler fixture bodies must not be interpreted")
  })

  it("exposes a snapshot boundary that delegates to Jj with key- and attempt-labelled messages", async () => {
    const calls: Array<JjCall> = []
    const result = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const boundary = yield* FlowEngine.SnapshotBoundary
        const options: FlowEngine.SnapshotBoundaryOptions = {
          flow: LayerFlow,
          executionId: "layer-exec",
          key: "step/one",
          attempt: 2,
          metadata: undefined
        }
        const snapshot = yield* boundary.snapshot(options)
        const diff = yield* boundary.diff(snapshot, options)
        yield* boundary.restore(snapshot, options)
        return { snapshot, diff }
      })).pipe(
        Effect.provide(
          EngineStore.layer({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(true)
          }).pipe(
            Layer.provideMerge(baseLayers(recordingJj(calls), DurableEngineState.makeMemory()))
          )
        ),
        Effect.scoped
      )
    )

    expect(result.snapshot).toBe("change-1")
    expect(result.diff).toBe("diff-body")
    expect(calls).toEqual([
      { op: "snapshot", argument: "flows activity step/one attempt 2" },
      { op: "snapshot", argument: "flows activity step/one attempt 2 settled" },
      { op: "diff", argument: "change-1->change-2" },
      { op: "restore", argument: "change-1" }
    ])
  })

  it("turns a Jj snapshot failure into a defect rather than a typed boundary error", async () => {
    const calls: Array<JjCall> = []
    const failing = recordingJj(calls, {
      snapshot: () => Effect.fail({ _tag: "JjError", message: "worktree busy" } as never)
    })
    const exit = await runPromise(
      Effect.scoped(
        Effect.exit(
          Effect.flatMap(
            FlowEngine.SnapshotBoundary,
            (boundary) =>
              boundary.snapshot({
                flow: LayerFlow,
                executionId: "layer-exec",
                key: "step/two",
                attempt: 1,
                metadata: undefined
              })
          )
        )
      ).pipe(
        Effect.provide(
          EngineStore.layer({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(true)
          }).pipe(
            Layer.provideMerge(baseLayers(failing, DurableEngineState.makeMemory()))
          )
        ),
        Effect.scoped
      )
    )

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(calls).toEqual([])
  })

  it("provides a flow engine from the same layer that drives a registered flow to completion", async () => {
    const state = DurableEngineState.makeMemory()
    const row = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(LayerFlow, () => Effect.succeed("layered"))
        const value = yield* engine.execute(LayerFlow, {
          executionId: "layered-run",
          payload: {},
          discard: false
        })
        const store = yield* RunStore.RunStore
        return { value, row: yield* store.get("layered-run") }
      })).pipe(
        Effect.provide(
          EngineStore.layer({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(true)
          }).pipe(
            Layer.provideMerge(baseLayers(recordingJj([]), state))
          )
        ),
        Effect.scoped
      )
    )

    expect(row.value).toBe("layered")
    expect(row.row.status).toBe("completed")
  })
})

describe("EngineStore.make liveness", () => {
  it("uses the required liveness probe, so a live foreign owner is never stolen from", async () => {
    let executions = 0
    const result = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        // Seed a `running` row owned by another host whose heartbeat is
        // ancient, so only the liveness probe stands between it and a steal.
        yield* store.create(
          "foreign-run",
          JSON.stringify({ version: 1, flowName: LayerFlow._tag, payload: {} })
        )
        const created = yield* store.get("foreign-run")
        const expected = { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs }
        const claim = yield* store.claim("foreign-run", expected, otherOwner, 0)
        expect(claim._tag).toBe("Claimed")
        yield* store.activate("foreign-run", otherOwner, 0, expected)
        // Backdate the heartbeat well past `heartbeatStaleAfter`, so the
        // liveness probe — not freshness — decides the steal.
        yield* store.heartbeat("foreign-run", otherOwner, 0)

        const engine = yield* EngineStore.make({
          owner: { hostId: "layer-host" },
          journalSource: "layer-test",
          isAlive: () => Effect.succeed(true)
        })
        yield* engine.register(
          LayerFlow,
          () =>
            Effect.sync(() => {
              executions++
              return "stolen"
            })
        )
        yield* engine.resume(LayerFlow, "foreign-run")
        const journal = yield* Journal.Journal
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "foreign-run" as never, limit: 100 })
        return { row: yield* store.get("foreign-run"), entries: entries.entries }
      })).pipe(
        Effect.provide(baseLayers(recordingJj([]), DurableEngineState.makeMemory()))
      )
    )

    expect(executions).toBe(0)
    expect(result.row.status).toBe("running")
    expect(result.row.owner).toEqual(otherOwner)
    const decisions = result.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => (entry.payload as { decision: string }).decision)
    expect(decisions).toContain("steal-refused-owner-alive")
  })

  it("replays an activity that declares no idempotency key from its own run journal", async () => {
    const state = DurableEngineState.makeMemory()
    let dispatches = 0
    const unkeyed = Activity.make({
      name: "unkeyed",
      success: Schema.String,
      tier: "sealed",
      execute: Effect.sync(() => {
        dispatches++
        return `dispatch-${dispatches}`
      })
    })
    const gate = DurableDeferred.make("engine-store-gate", { success: Schema.String })
    const handler = () =>
      Effect.gen(function*() {
        const value = yield* unkeyed
        const released = yield* DurableDeferred.await(gate)
        return `${value}/${released}`
      })

    const result = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const makeEngine = EngineStore.make({
          owner: { hostId: "layer-host" },
          journalSource: "layer-test",
          isAlive: () => Effect.succeed(false)
        })
        const first = yield* makeEngine
        yield* first.register(LayerFlow, handler)
        yield* first.execute(LayerFlow, {
          executionId: "unkeyed-run",
          payload: {},
          discard: true
        })
        const store = yield* RunStore.RunStore
        const suspended = yield* store.get("unkeyed-run")

        // A fresh engine over the same durable state models a restart.
        const restarted = yield* makeEngine
        yield* restarted.register(LayerFlow, handler)
        yield* restarted.deferredDone(gate, {
          flowName: LayerFlow._tag,
          executionId: "unkeyed-run",
          deferredName: gate.name,
          exit: Exit.succeed("released")
        })
        const value = yield* restarted.execute(LayerFlow, {
          executionId: "unkeyed-run",
          payload: {},
          discard: false
        })
        return { suspended, value }
      })).pipe(
        Effect.provide(baseLayers(recordingJj([]), state))
      )
    )

    expect(result.suspended.status).toBe("suspended")
    expect(result.value).toBe("dispatch-1/released")
    // Replay came from the run's own attempt journal, not a second dispatch.
    expect(dispatches).toBe(1)
  })
})

describe("EngineStore boundary metadata", () => {
  it("forwards a hermetic boundary descriptor so a sealed result is shared across runs", async () => {
    const state = DurableEngineState.makeMemory()
    let dispatches = 0
    const hermetic = Activity.make({
      name: "hermetic",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "engine-store-hermetic-v1",
      metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" },
      execute: Effect.sync(() => {
        dispatches++
        return "hermetic-result"
      })
    })

    const result = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "layer-host" },
          journalSource: "layer-test",
          isAlive: () => Effect.succeed(false)
        })
        yield* engine.register(LayerFlow, () => hermetic as unknown as Effect.Effect<string, never, never>)
        const first = yield* engine.execute(LayerFlow, {
          executionId: "hermetic-a",
          payload: {},
          discard: false
        })
        const second = yield* engine.execute(LayerFlow, {
          executionId: "hermetic-b",
          payload: {},
          discard: false
        })
        return { first, second }
      })).pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayers(recordingJj([]), state),
            // Cross-run reuse is only offered once the composition states the
            // environment its sealed keys were computed under: an undeclared
            // environment pins the key to its own execution, so the two runs
            // would address distinct rows and never share.
            Activity.layerCacheEnvironment({ layers: [], capabilities: {} })
          )
        )
      )
    )

    expect(result.first).toBe("hermetic-result")
    expect(result.second).toBe("hermetic-result")
    // The declared hard boundary with whole-tree write proof makes the sealed
    // result cacheable, so the second run replays it instead of dispatching.
    expect(dispatches).toBe(1)
  })

  it("keeps a sealed result run-local while the cache environment is absent", async () => {
    // The admission half of the same invariant: identical declarations, an
    // identical hard boundary, and no declared environment must still execute
    // twice, because nothing proves the second run resolves the same layers
    // and capabilities as the first.
    const state = DurableEngineState.makeMemory()
    let dispatches = 0
    const hermetic = Activity.make({
      name: "hermetic-undeclared",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "engine-store-hermetic-undeclared-v1",
      metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" },
      execute: Effect.sync(() => {
        dispatches++
        return `hermetic-result-${dispatches}`
      })
    })

    const result = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "layer-host" },
          journalSource: "layer-test",
          isAlive: () => Effect.succeed(false)
        })
        yield* engine.register(LayerFlow, () => hermetic as unknown as Effect.Effect<string, never, never>)
        const first = yield* engine.execute(LayerFlow, {
          executionId: "undeclared-a",
          payload: {},
          discard: false
        })
        const second = yield* engine.execute(LayerFlow, {
          executionId: "undeclared-b",
          payload: {},
          discard: false
        })
        return { first, second }
      })).pipe(Effect.provide(baseLayers(recordingJj([]), state)))
    )

    expect(result.first).toBe("hermetic-result-1")
    expect(result.second).toBe("hermetic-result-2")
    expect(dispatches).toBe(2)
  })
})
