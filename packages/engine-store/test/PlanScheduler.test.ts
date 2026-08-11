/**
 * Deterministic evaluation tests for the node scheduler, in the ethos of
 * Skyframe's `GraphTester`: the graph is declared as data, driven, and
 * asserted on. Determinism comes from Effect itself — a `Latch` to pin the
 * interleaving of two concurrently admitted nodes — rather than from the
 * `DeterministicHelper` the vault rejected. Nothing here sleeps.
 */
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan, PlanStore } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import { describe, expect, it } from "vitest"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { runPromise } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "scheduler-host", pid: 91, nonce: "scheduler-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "scheduler-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

interface DraftOptions {
  readonly body?: unknown
  readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
  readonly reads?: ReadonlyArray<string>
  readonly writes?: ReadonlyArray<string>
  readonly kind?: Plan.PlanNode["kind"]
  readonly priority?: number
  readonly conflictStrategy?: Plan.PairStrategy
  readonly runtimeStrategy?: Plan.RuntimeStrategy
  readonly boundaryMode?: "hard" | "expected"
}

const draft = (id: string, options: DraftOptions = {}): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: options.body ?? { activity: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: options.reads ?? [],
    writes: options.writes ?? [`${id}.out`],
    boundaryMode: options.boundaryMode ?? "hard"
  },
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy })
})

const compile = (nodes: ReadonlyArray<Plan.NodeDraft>, planId = "plan-1") =>
  Plan.compile({ planId, flow: "example/Build", nodes })

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    /* v8 ignore next */
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    /* v8 ignore next */
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const outcomes = (report: PlanScheduler.Report): Record<string, PlanScheduler.Outcome> =>
  Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.outcome]))

interface Harness {
  readonly runId: string
  readonly executor: PlanScheduler.Executor
  readonly boundary?: Layer.Layer<StepBoundary.Service> | undefined
  readonly reconciliation?: Layer.Layer<Reconciliation.Reconciliation> | undefined
  readonly options?: Omit<PlanScheduler.Options, "runId" | "owner" | "sourceId"> | undefined
}

const harness = (harness: Harness) =>
  Layer.mergeAll(
    harness.boundary ?? StepBoundary.layerTest(),
    jjLayer,
    PlanScheduler.layerExecutor(harness.executor),
    ...(harness.reconciliation === undefined ? [] : [harness.reconciliation])
  )

const scheduler = (options: Harness) =>
  PlanScheduler.make({
    runId: options.runId,
    owner,
    sourceId: `scheduler/${options.runId}`,
    ...options.options
  })

describe("PlanScheduler over a static graph", () => {
  it("records the plan, builds every node, and reports the plan digest", async () => {
    const plan = await runPromise(compile([
      draft("source"),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }], reads: ["source.out"] }),
      draft("sibling")
    ]))
    const order: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          order.push(node.id)
          return { ran: node.id }
        })
    }
    const program = Effect.gen(function*() {
      yield* activate("run-static")
      const service = scheduler({ runId: "run-static", executor })
      const recorded = yield* service.record(plan)
      const report = yield* service.run(plan)
      const events = yield* JournalRecords.entries("run-static", undefined, 512)
      return { events, recorded, report }
    }).pipe(Effect.provide(harness({ runId: "run-static", executor })), Effect.provide(TestStores.layer()))

    const { events, recorded, report } = await runPromise(program)
    expect(recorded).toEqual({ _tag: "Recorded" })
    expect(outcomes(report)).toEqual({ source: "built", derived: "built", sibling: "built" })
    expect(report.digest).toBe(plan.digest)
    expect(order.indexOf("derived")).toBeGreaterThan(order.indexOf("source"))
    expect(report.results).toEqual({
      source: { ran: "source" },
      derived: { ran: "derived" },
      sibling: { ran: "sibling" }
    })
    const types = events.entries.map((entry) => entry.eventType)
    expect(types).toContain("flows.engine.plan-recorded")
    expect(types).toContain("flows.engine.node-scheduled")
    expect(types.filter((type) => type === "flows.engine.node-settled").length).toBe(3)
  })

  it("re-keys one leaf and re-runs only its cone — every unchanged branch is a cache hit", async () => {
    const graph = (seed: number) => [
      draft("source", { body: { seed } }),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
      draft("sibling"),
      draft("sibling-child", { inputs: [{ _tag: "Pending", from: "sibling" }] })
    ]
    const before = await runPromise(compile(graph(1)))
    const after = await runPromise(compile(graph(2)))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
    const stores = TestStores.layer()
    const program = Effect.gen(function*() {
      yield* activate("run-rekey")
      const service = scheduler({ runId: "run-rekey", executor })
      yield* service.record(before)
      const first = yield* service.run(before)
      const second = yield* service.run(after)
      return { first, second }
    }).pipe(Effect.provide(harness({ runId: "run-rekey", executor })), Effect.provide(stores))

    const { first, second } = await runPromise(program)
    expect(outcomes(first)).toEqual({
      source: "built",
      derived: "built",
      sibling: "built",
      "sibling-child": "built"
    })
    // THE BAZEL-SHAPED PROMISE: the edited leaf and its dependent re-ran; the
    // branch nothing touched was served from the content-addressed cache.
    expect(outcomes(second)).toEqual({
      source: "built",
      derived: "built",
      sibling: "clean",
      "sibling-child": "clean"
    })
  })

  it("halts the cone below a failure", async () => {
    const plan = await runPromise(compile([
      draft("root"),
      draft("broken", { inputs: [{ _tag: "Pending", from: "root" }] }),
      draft("downstream", { inputs: [{ _tag: "Pending", from: "broken" }] }),
      draft("untouched")
    ]))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) => node.id === "broken" ? Effect.fail("no") : Effect.succeed(node.id)
    }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-halt")
        return yield* scheduler({ runId: "run-halt", executor }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-halt", executor })), Effect.provide(TestStores.layer()))
    )
    expect(outcomes(report)).toEqual({
      root: "built",
      broken: "failed",
      downstream: "skipped",
      untouched: "built"
    })
  })
})

describe("PlanScheduler admission", () => {
  it("admits by cap, orders by priority, and ages waiting work so nothing starves", async () => {
    const plan = await runPromise(compile([
      draft("low-first"),
      draft("high", { priority: 5 }),
      draft("low-second")
    ]))
    const order: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          order.push(node.id)
          return node.id
        })
    }
    await runPromise(
      Effect.gen(function*() {
        yield* activate("run-priority")
        return yield* scheduler({ runId: "run-priority", executor, options: { concurrency: { steps: 1 } } }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-priority", executor })), Effect.provide(TestStores.layer()))
    )
    // Round 1 admits `high` (5 > 0). Rounds 2 and 3 admit the two low-priority
    // nodes, which each gained a point of age: priority changed latency, and
    // nothing starved.
    expect(order).toEqual(["high", "low-first", "low-second"])
  })

  it("charges an agent node against both caps", async () => {
    const plan = await runPromise(compile([
      draft("agent-a", { kind: "agent" }),
      draft("agent-b", { kind: "agent" }),
      draft("compute")
    ]))
    const rounds: Array<Array<string>> = []
    const started = new Set<string>()
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          started.add(node.id)
          return node.id
        })
    }
    await runPromise(
      Effect.gen(function*() {
        yield* activate("run-agents")
        const service = scheduler({
          runId: "run-agents",
          executor,
          options: { concurrency: { steps: 2, agents: 1 } }
        })
        const report = yield* service.run(plan)
        rounds.push(report.settlements.map((settlement) => settlement.nodeId))
        return report
      }).pipe(Effect.provide(harness({ runId: "run-agents", executor })), Effect.provide(TestStores.layer()))
    )
    // Two step permits, one agent permit: the first round runs one agent and
    // the compute node, so the second agent waits a round.
    expect(started.size).toBe(3)
  })

  it("runs concurrently admitted nodes together", async () => {
    const plan = await runPromise(compile([draft("left"), draft("right")]))
    const program = Effect.gen(function*() {
      const gate = yield* Latch.make()
      const both = yield* Ref.make(0)
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) =>
          Effect.gen(function*() {
            const arrived = yield* Ref.updateAndGet(both, (count) => count + 1)
            // The second arrival opens the gate the first is waiting on: this
            // completes only if the two ran concurrently.
            if (arrived === 2) yield* Latch.open(gate)
            yield* Latch.await(gate)
            return node.id
          })
      }
      yield* activate("run-parallel")
      return yield* Effect.provide(
        scheduler({ runId: "run-parallel", executor }).run(plan),
        harness({ runId: "run-parallel", executor })
      )
    }).pipe(Effect.provide(TestStores.layer()))
    const report = await runPromise(program)
    expect(outcomes(report)).toEqual({ left: "built", right: "built" })
  })
})

const conflict = () =>
  new WorkspaceSandbox.MaterializationConflict({
    paths: ["shared.out"],
    message: "the host moved under the transaction"
  })

describe("PlanScheduler conflict strategies", () => {
  it("delay/rebase re-keys a new attempt and lands within its bound", async () => {
    const plan = await runPromise(compile([draft("racer", { writes: ["shared.out"] })]))
    const attempts = await runPromise(
      Effect.gen(function*() {
        const seen = yield* Ref.make(0)
        const executor: PlanScheduler.Executor = {
          execute: () =>
            Effect.flatMap(
              Ref.updateAndGet(seen, (count) => count + 1),
              (count) => count < 3 ? Effect.fail(conflict()) : Effect.succeed("landed")
            )
        }
        yield* activate("run-rebase")
        const report = yield* Effect.provide(
          scheduler({ runId: "run-rebase", executor, options: { rebaseLimit: 3 } }).run(plan),
          harness({ runId: "run-rebase", executor })
        )
        return report.settlements[0]!
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(attempts.outcome).toBe("built")
    expect(attempts.rebases).toBe(2)
    expect(attempts.attempts).toBe(3)
  })

  it("delay/rebase is bounded — an exhausted budget asks reconciliation and fails", async () => {
    const plan = await runPromise(compile([
      draft("holder", { writes: ["shared.out"] }),
      draft("racer", { writes: ["shared.out"] })
    ]))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) => node.id === "racer" ? Effect.fail(conflict()) : Effect.succeed(node.id)
    }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-rebase-exhausted")
        return yield* Effect.provide(
          scheduler({ runId: "run-rebase-exhausted", executor, options: { rebaseLimit: 1 } }).run(plan),
          harness({ runId: "run-rebase-exhausted", executor, reconciliation: Reconciliation.layerDefault })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.settlements[1]).toMatchObject({ nodeId: "racer", outcome: "failed", rebases: 1, attempts: 2 })
    expect(report.verdicts).toEqual([{
      nodeId: "racer",
      verdict: { _tag: "Fail", reason: "racer could not land after 1 rebases under delay-rebase" }
    }])
  })

  it("stop/merge stops the loser and routes both lanes through an appended merge node", async () => {
    const plan = await runPromise(compile([
      draft("lane-a", { writes: ["shared.out"] }),
      draft("lane-b", { writes: ["shared.out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
    ]))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        node.id === "lane-b"
          ? Effect.fail(conflict())
          : node.kind === "merge"
          ? Effect.succeed({ merged: node.material.body })
          : Effect.succeed(node.id)
    }
    const { persisted, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-merge")
        const service = scheduler({ runId: "run-merge", executor })
        // The merge node is an elaboration of the SAME plan, so the plan has
        // to be on disk for one to be appended to it.
        yield* service.record(plan)
        const report = yield* Effect.provide(service.run(plan), harness({ runId: "run-merge", executor }))
        const store = yield* PlanStore.PlanStore
        return { persisted: yield* store.get("plan-1"), report }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.appended).toEqual(["lane-b+merge"])
    expect(outcomes(report)).toEqual({ "lane-a": "built", "lane-b": "skipped", "lane-b+merge": "built" })
    expect(report.results["lane-b+merge"]).toEqual({ merged: { merge: { stopped: "lane-b", winners: ["lane-a"] } } })
    // And it landed in the persisted plan as generation 1, not only in memory.
    expect(Option.getOrThrow(persisted).nodes.map((node) => node.id)).toEqual(["lane-a", "lane-b", "lane-b+merge"])
    expect(Option.getOrThrow(persisted).generation).toBe(1)
  })
})

describe("PlanScheduler reconciliation", () => {
  const deviating = (paths: ReadonlyArray<string>) => StepBoundary.layerTest({ changedPaths: paths })

  it("gives the expected-set-deviation event its first consumer", async () => {
    const plan = await runPromise(compile([draft("loose", { writes: ["declared.out"], boundaryMode: "expected" })]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("done") }
    const seen: Array<Reconciliation.Deviation> = []
    const recorder = Reconciliation.layer({
      onDeviation: (deviation) =>
        Effect.sync(() => {
          seen.push(deviation)
          return { _tag: "FactorOut", paths: deviation.paths, reason: "observed" } as const
        }),
      /* v8 ignore next */
      onConflict: () => Effect.succeed({ _tag: "Fail", reason: "unused" } as const)
    })
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-deviation")
        return yield* Effect.provide(
          scheduler({ runId: "run-deviation", executor }).run(plan),
          harness({
            runId: "run-deviation",
            executor,
            boundary: deviating(["node_modules/.bin/x"]),
            reconciliation: recorder
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ nodeId: "loose", paths: ["node_modules/.bin/x"] })
    expect(report.verdicts[0]?.verdict._tag).toBe("FactorOut")
  })

  it("the default reorders when the deviation names another node's declared write", async () => {
    const plan = await runPromise(compile([
      draft("writer", { writes: ["shared.out"] }),
      draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
      draft("later", { inputs: [{ _tag: "Pending", from: "writer" }], writes: ["later.out"] })
    ]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-reorder")
        return yield* Effect.provide(
          scheduler({ runId: "run-reorder", executor, options: { concurrency: { steps: 1 } } }).run(plan),
          harness({
            runId: "run-reorder",
            executor,
            boundary: deviating(["shared.out"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    const reorder = report.verdicts.find((entry) => entry.verdict._tag === "Reorder")
    expect(reorder?.verdict).toMatchObject({ _tag: "Reorder", dependsOn: ["writer"] })
  })

  it("the default fails a deviation no declaration explains", async () => {
    const plan = await runPromise(compile([draft("mystery", { boundaryMode: "expected" })]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("done") }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-mystery")
        return yield* Effect.provide(
          scheduler({ runId: "run-mystery", executor }).run(plan),
          harness({
            runId: "run-mystery",
            executor,
            boundary: deviating(["/tmp/whatever"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts[0]?.verdict._tag).toBe("Fail")
    expect(outcomes(report)).toEqual({ mystery: "failed" })
  })

  it("the default factors out two nodes that deviated identically", async () => {
    const plan = await runPromise(compile([
      draft("install-a", { boundaryMode: "expected" }),
      draft("install-b", { boundaryMode: "expected" })
    ]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-factor")
        return yield* Effect.provide(
          scheduler({ runId: "run-factor", executor }).run(plan),
          harness({
            runId: "run-factor",
            executor,
            boundary: deviating(["node_modules/left-pad"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    // BOTH sides, not just whichever the journal happened to list second.
    // Two steps that produced the same undeclared paths are one symmetric
    // fact, and neither of them is the anomaly the `Fail` default is for.
    expect(report.verdicts.map((entry) => entry.verdict._tag)).toEqual(["FactorOut", "FactorOut"])
    expect(report.verdicts.map((entry) => entry.nodeId).sort()).toEqual(["install-a", "install-b"])
    expect(outcomes(report)).toEqual({ "install-a": "built", "install-b": "built" })
  })

  it("drains deviations past the first page of the journal", async () => {
    // The reconciliation seam reads the journal a page at a time. A wide round
    // journals more records than one page holds, and the last round has no
    // successor to pick up the remainder — so a deviation beyond the cursor
    // would never reach the seam at all. Filler records push the only real
    // deviation off the first page.
    const plan = await runPromise(compile([draft("late", { boundaryMode: "expected" })]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-paged")
        const journal = yield* Journal.Journal
        yield* Effect.forEach(
          Array.from({ length: 600 }, (_, index) => index),
          (index) =>
            journal.emitDurable(
              JournalRecords.runDecision(
                { runId: "run-paged", lineageId: "run-paged/root", sourceId: `filler/${index}` },
                { index }
              ),
              owner
            ),
          { discard: true }
        )
        return yield* Effect.provide(
          scheduler({ runId: "run-paged", executor }).run(plan),
          harness({
            runId: "run-paged",
            executor,
            boundary: deviating(["node_modules/late"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts.map((entry) => entry.nodeId)).toEqual(["late"])
    expect(report.verdicts[0]?.verdict._tag).toBe("Fail")
  })
})

describe("PlanScheduler elaboration", () => {
  it("appends a subgraph to the same plan and journals it", async () => {
    const base = await runPromise(compile([draft("root")]))
    const grown = await runPromise(Plan.append(base, [draft("child", { inputs: [{ _tag: "Pending", from: "root" }] })]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const { events, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-elaborate")
        const service = scheduler({ runId: "run-elaborate", executor })
        yield* service.record(base)
        yield* service.append(grown)
        const report = yield* service.run(grown)
        const events = yield* JournalRecords.entries("run-elaborate", undefined, 512)
        return { events, report }
      }).pipe(Effect.provide(harness({ runId: "run-elaborate", executor })), Effect.provide(TestStores.layer()))
    )
    expect(outcomes(report)).toEqual({ root: "built", child: "built" })
    const appendedEvent = events.entries.find((entry) => entry.eventType === "flows.engine.subgraph-appended")
    expect(appendedEvent?.payload).toMatchObject({ generation: 1, nodeIds: ["child"] })
  })

  it("reports a store refusal as a typed scheduler error", async () => {
    const plan = await runPromise(compile([draft("root")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-store-failure")
        const service = scheduler({ runId: "run-store-failure", executor })
        yield* service.record(plan)
        return yield* Effect.flip(service.append(plan))
      }).pipe(Effect.provide(harness({ runId: "run-store-failure", executor })), Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "store_failed" })
  })

  it("self-interrupts when the run was reclaimed under it", async () => {
    const plan = await runPromise(compile([draft("root")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const exit = await runPromise(
      Effect.exit(scheduler({ runId: "run-zombie", executor }).record(plan)).pipe(
        Effect.provide(harness({ runId: "run-zombie", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    // The run row was never claimed by this owner, so the fenced emit reports
    // `fence_lost` and the scheduler stops rather than driving a plan it no
    // longer owns.
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("surfaces a host that cannot measure the plan's inputs", async () => {
    const plan = await runPromise(compile([draft("reader", { reads: ["absent.txt"] })]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-unmeasurable")
        return yield* Effect.provide(
          Effect.flip(scheduler({ runId: "run-unmeasurable", executor }).run(plan)),
          harness({ runId: "run-unmeasurable", executor, boundary: StepBoundary.layerTest({ supported: false }) })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "boundary_unavailable" })
  })
})

describe("PlanScheduler invalidation and journal plumbing", () => {
  /** A host whose measurement moves under the run, one prepare at a time. */
  const shifting = () => {
    let counter = 0
    return Layer.succeed(
      StepBoundary.StepBoundary,
      StepBoundary.make({
        prepare: Effect.fn("prepare")(function*(descriptor) {
          counter = counter + 1
          const digest = `measured-${counter}`
          return { descriptor, readSnapshot: descriptor.readSet.map((entry) => ({ path: entry.path, digest })) }
        }),
        settle: Effect.fn("settle")(function*(prepared) {
          return {
            declaredOutputs: { paths: prepared.descriptor.writeSet },
            diffIdentity: "shifting",
            wholeTreeWritesVerified: true as const
          }
        }),
        replayOutputs: Effect.fn("replayOutputs")(function*() {})
      })
    )
  }

  it("journals a re-key when the measured inputs move under a rebase", async () => {
    // The node reads a path the plan also writes, so it is not pinned as a
    // source: each attempt re-measures it, which is exactly the case a
    // re-key has to describe.
    const plan = await runPromise(compile([draft("racer", { reads: ["shared.out"], writes: ["shared.out"] })]))
    const { events, report } = await runPromise(
      Effect.gen(function*() {
        const seen = yield* Ref.make(0)
        const executor: PlanScheduler.Executor = {
          execute: () =>
            Effect.flatMap(
              Ref.updateAndGet(seen, (count) => count + 1),
              (count) => count === 1 ? Effect.fail(conflict()) : Effect.succeed("landed")
            )
        }
        yield* activate("run-invalidated")
        const report = yield* Effect.provide(
          scheduler({ runId: "run-invalidated", executor }).run(plan),
          harness({ runId: "run-invalidated", executor, boundary: shifting() })
        )
        const events = yield* JournalRecords.entries("run-invalidated", undefined, 512)
        return { events, report }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.settlements[0]).toMatchObject({ outcome: "built", rebases: 1 })
    const invalidated = events.entries.filter((entry) => entry.eventType === "flows.engine.node-invalidated")
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]?.payload).toMatchObject({ nodeId: "racer", reason: "measured-inputs-changed" })
  })

  it("reorders onto a writer that has not dispatched yet", async () => {
    const plan = await runPromise(compile([
      draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
      draft("writer", { writes: ["shared.out"] })
    ]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-reorder-ahead")
        return yield* Effect.provide(
          scheduler({ runId: "run-reorder-ahead", executor, options: { concurrency: { steps: 1 } } }).run(plan),
          harness({
            runId: "run-reorder-ahead",
            executor,
            boundary: StepBoundary.layerTest({ changedPaths: ["shared.out"] }),
            reconciliation: Reconciliation.layer(Reconciliation.make(Reconciliation.makeDefault()))
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts[0]?.verdict).toMatchObject({ _tag: "Reorder", dependsOn: ["writer"] })
    // The ordering edge bound work that had not dispatched: `writer` still ran.
    expect(outcomes(report)).toEqual({ deviator: "built", writer: "built" })
  })

  it("ignores journalled deviations it cannot attribute to a node of this plan", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-foreign")
        const journal = yield* Journal.Journal
        yield* journal.emitDurable(
          JournalRecords.expectedSetDeviation({
            runId: "run-foreign",
            lineageId: "run-foreign/root",
            sourceId: "foreign/malformed"
          }, {}),
          owner
        )
        yield* journal.emitDurable(
          JournalRecords.expectedSetDeviation({
            runId: "run-foreign",
            lineageId: "run-foreign/root",
            sourceId: "foreign/unknown"
          }, {
            stepKeyDigest: "not-a-node-of-this-plan",
            attempt: 1,
            paths: ["x"],
            diffIdentity: "d"
          }),
          owner
        )
        return yield* Effect.provide(
          scheduler({ runId: "run-foreign", executor }).run(plan),
          harness({ runId: "run-foreign", executor, reconciliation: Reconciliation.layerDefault })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts).toEqual([])
    expect(outcomes(report)).toEqual({ solo: "built" })
  })

  it("reports a journal failure that is not merely a lost fence as a store failure", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-journal-broken")
        return yield* Effect.flip(scheduler({ runId: "run-journal-broken", executor }).record(plan)).pipe(
          // A CLOSED journal, not a reclaimed run: the scheduler reports it
          // instead of self-interrupting, because nothing took the run away.
          Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop()))
        )
      }).pipe(Effect.provide(harness({ runId: "run-journal-broken", executor })), Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "store_failed" })
  })

  it("is reachable as a layer", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-layer")
        const service = yield* PlanScheduler.PlanScheduler
        return yield* service.run(plan)
      }).pipe(
        Effect.provide(PlanScheduler.layer({ runId: "run-layer", owner, sourceId: "scheduler/run-layer" })),
        Effect.provide(harness({ runId: "run-layer", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    expect(outcomes(report)).toEqual({ solo: "built" })
  })
})
