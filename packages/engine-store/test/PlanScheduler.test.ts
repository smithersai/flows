/**
 * Deterministic evaluation tests for the node scheduler, in the ethos of
 * Skyframe's `GraphTester`: the graph is declared as data, driven, and
 * asserted on. Determinism comes from Effect itself — a `Latch` to pin the
 * interleaving of two concurrently admitted nodes — rather than from the
 * `DeterministicHelper` the vault rejected. Nothing here sleeps.
 */
import { describe, expect, it } from "@effect/vitest"
import type { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import { Journal } from "@smthrs/journal-next"
import { Jj } from "@smthrs/kernel-next"
import { KeyMaterial, Plan, PlanStore, StepKey } from "@smthrs/plan-next"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store-next"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

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
  readonly removes?: ReadonlyArray<string>
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
    body: options.body ?? { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: options.reads ?? [],
    writes: options.writes ?? [`${id}.out`],
    ...(options.removes === undefined ? {} : { removes: options.removes }),
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
  it.effect("refuses a source glob when no filesystem service can expand it", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([{
        ...draft("glob-source"),
        effects: {
          reads: [{ _tag: "Glob", include: ["src/**"] }],
          writes: ["glob-source.out"],
          boundaryMode: "hard"
        }
      }]))
      const executor: PlanScheduler.Executor = { execute: () => Effect.die("must not execute") }
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-glob-no-fs")
          return yield* Effect.flip(scheduler({ runId: "run-glob-no-fs", executor }).run(plan))
        }).pipe(Effect.provide(harness({ runId: "run-glob-no-fs", executor })), Effect.provide(TestStores.layer()))
      )
      expect(failure).toMatchObject({ code: "boundary_unavailable" })
    }))

  it.effect("records the plan, builds every node, and reports the plan digest", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
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

      const { events, recorded, report } = yield* withCrypto(program)
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
    }))

  it.effect("hands an executor only projected Ref inputs, never ordering results", () =>
    Effect.gen(function*() {
      // An executor may only see data the dispatch key folds. The key folds a
      // Ref's PROJECTED digest and a constant for Pending, so the input record
      // carries exactly the projections — a Pending dependency's result or a
      // Ref's unprojected sibling fields would let a body consume state the key
      // never described, and a `clean` verdict would then serve a stale result.
      const plan = yield* withCrypto(compile([
        draft("source"),
        draft("orderer"),
        draft("consumer", {
          inputs: [
            { _tag: "Ref", from: "source", path: ["nested", "field"] },
            { _tag: "Pending", from: "orderer" }
          ]
        })
      ]))
      const seen: Array<PlanScheduler.NodeInput["inputs"]> = []
      const executor: PlanScheduler.Executor = {
        execute: ({ inputs, node }) =>
          Effect.sync(() => {
            if (node.id === "consumer") seen.push(inputs)
            return node.id === "source" ? { nested: { field: "projected" }, sibling: "hidden" } : { ran: node.id }
          })
      }
      const program = Effect.gen(function*() {
        yield* activate("run-projected-inputs")
        return yield* scheduler({ runId: "run-projected-inputs", executor }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-projected-inputs", executor })), Effect.provide(TestStores.layer()))

      const report = yield* withCrypto(program)
      expect(outcomes(report)).toEqual({ source: "built", orderer: "built", consumer: "built" })
      expect(seen).toEqual([[{ from: "source", path: ["nested", "field"], value: "projected" }]])
    }))

  it.effect("preserves every dispatch key in a diamond plan", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("producer"),
        draft("left", { inputs: [{ _tag: "Ref", from: "producer", path: [] }] }),
        draft("right", { inputs: [{ _tag: "Ref", from: "producer", path: [] }] })
      ], "diamond-plan"))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-diamond")
          return yield* scheduler({ runId: "run-diamond", executor }).run(plan)
        }).pipe(Effect.provide(harness({ runId: "run-diamond", executor })), Effect.provide(TestStores.layer()))
      )
      expect(Object.fromEntries(report.settlements.map(({ dispatchKey, nodeId }) => [nodeId, dispatchKey]))).toEqual({
        producer: "key1_a2f7c76258f4ab3fa6df7e1668397e17ad3ec97158279b24b8f0f7688cfb50e8",
        left: "key1_e9e2811e03fa18cf7e5ddae49b3e6a52354f87de283b8a244c02090549c4b623",
        right: "key1_b556bfd989cf1c299166399064880ded26b2abc2ea43398c6bcc6110352c5002"
      })
    }))

  it.effect("threads the engine-resolved environment into dispatch identity", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("environment")], "environment-plan"))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const { absent, present } = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-environment-absent")
          const absent = yield* scheduler({ runId: "run-environment-absent", executor }).run(plan)
          yield* activate("run-environment-present")
          const present = yield* scheduler({
            runId: "run-environment-present",
            executor,
            options: {
              environment: {
                declared: true,
                layers: ["workspace"],
                capabilities: { fs: ["read"] }
              }
            }
          }).run(plan)
          return { absent, present }
        }).pipe(
          Effect.provide(harness({ runId: "run-environment", executor })),
          Effect.provide(TestStores.layer())
        )
      )
      expect(present.settlements[0]?.dispatchKey).not.toBe(absent.settlements[0]?.dispatchKey)
    }))

  it.effect("re-keys one leaf and re-runs only its cone — every unchanged branch is a cache hit", () =>
    Effect.gen(function*() {
      const graph = (seed: number) => [
        draft("source", { body: { seed } }),
        draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
        draft("sibling"),
        draft("sibling-child", { inputs: [{ _tag: "Pending", from: "sibling" }] })
      ]
      const before = yield* withCrypto(compile(graph(1)))
      const after = yield* withCrypto(compile(graph(2)))
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

      const { first, second } = yield* withCrypto(program)
      expect(outcomes(first)).toEqual({
        source: "built",
        derived: "built",
        sibling: "built",
        "sibling-child": "built"
      })
      // THE BAZEL-SHAPED PROMISE: the edited leaf re-ran and the branch nothing
      // touched was served from the content-addressed cache.
      //
      // `derived` is `clean` here, and that is the early cutoff working. The
      // edit changed `source`'s declaration, so `source` re-ran — but this
      // executor returns `{ran: node.id}` for either seed, so the value
      // `derived` consumes is byte-identical to what it consumed before. A
      // dispatch key that folded the upstream PLAN key would have re-run it
      // anyway; `StepKey.dispatchIdentity` folds the upstream's settled output
      // instead, so invalidation stops at unchanged content the way Bazel's
      // `ActionCacheChecker` does.
      expect(outcomes(second)).toEqual({
        source: "built",
        derived: "clean",
        sibling: "clean",
        "sibling-child": "clean"
      })
    }))

  it.effect("carries declared removals into the measured boundary and orders readers behind them", () =>
    Effect.gen(function*() {
      // A removal moves a path's content exactly as a write does, so the plan
      // orders the reader behind the remover, the scheduler treats the path as
      // produced rather than pinning it as a source input, and the descriptor
      // the boundary settles against says the absence was declared.
      const plan = yield* withCrypto(compile([
        draft("reader", { reads: ["stale.txt"] }),
        draft("remover", { writes: ["remover.out"], removes: ["stale.txt"] })
      ]))
      const seen: Array<FileBoundary> = []
      const order: Array<string> = []
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary, node }) =>
          Effect.sync(() => {
            order.push(node.id)
            seen.push(boundary)
            return { ran: node.id }
          })
      }
      const program = Effect.gen(function*() {
        yield* activate("run-removes")
        const service = scheduler({ runId: "run-removes", executor })
        yield* service.record(plan)
        return yield* service.run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-removes", executor })), Effect.provide(TestStores.layer()))

      expect(outcomes(yield* withCrypto(program))).toEqual({ reader: "built", remover: "built" })
      expect(order.indexOf("reader")).toBeGreaterThan(order.indexOf("remover"))
      expect(seen.find((boundary) => boundary.removes !== undefined)?.removes).toEqual(["stale.txt"])
    }))

  it.effect("re-runs a dependent when the upstream's settled VALUE changes, not merely its declaration", () =>
    Effect.gen(function*() {
      // The other half of the cutoff: content, not identity, is the trigger. The
      // executor makes `source`'s output track the seed, so the same edit that
      // was invisible above must now propagate.
      const graph = (seed: number) => [
        draft("source", { body: { seed } }),
        draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] })
      ]
      const before = yield* withCrypto(compile(graph(1)))
      const after = yield* withCrypto(compile(graph(2)))
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) =>
          Effect.succeed(
            node.id === "source" ? { seed: (node.material.body as { seed: number }).seed } : { ran: node.id }
          )
      }
      const program = Effect.gen(function*() {
        yield* activate("run-value")
        const service = scheduler({ runId: "run-value", executor })
        yield* service.record(before)
        yield* service.run(before)
        return yield* service.run(after)
      }).pipe(Effect.provide(harness({ runId: "run-value", executor })), Effect.provide(TestStores.layer()))

      expect(outcomes(yield* withCrypto(program))).toEqual({ source: "built", derived: "built" })
    }))

  it.effect("halts the cone below a failure", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("root"),
        draft("broken", { inputs: [{ _tag: "Pending", from: "root" }] }),
        draft("downstream", { inputs: [{ _tag: "Pending", from: "broken" }] }),
        draft("untouched")
      ]))
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) => node.id === "broken" ? Effect.fail("no") : Effect.succeed(node.id)
      }
      const report = yield* withCrypto(
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
    }))
})

describe("PlanScheduler admission", () => {
  it.effect("admits by cap, orders by priority, and ages waiting work so nothing starves", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
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
      yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-priority")
          return yield* scheduler({ runId: "run-priority", executor, options: { concurrency: { steps: 1 } } }).run(plan)
        }).pipe(Effect.provide(harness({ runId: "run-priority", executor })), Effect.provide(TestStores.layer()))
      )
      // Round 1 admits `high` (5 > 0). Rounds 2 and 3 admit the two low-priority
      // nodes, which each gained a point of age: priority changed latency, and
      // nothing starved.
      expect(order).toEqual(["high", "low-first", "low-second"])
    }))

  it.effect("charges an agent node against both caps", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
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
      yield* withCrypto(
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
    }))

  it.effect("runs concurrently admitted nodes together", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("left"), draft("right")]))
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
      const report = yield* withCrypto(program)
      expect(outcomes(report)).toEqual({ left: "built", right: "built" })
    }))

  /**
   * The reader-after-writer edge, observed where it matters: a node that reads
   * a path another node writes must not be in the same wavefront round as its
   * producer, or it measures pre-producer bytes and the dispatch key records
   * that wrong execution as a legitimate one.
   *
   * The trace is read as an interleaving. Each body announces itself, yields,
   * and announces its end, so two nodes admitted in one round always interleave
   * and two nodes in different rounds never can. The first assertion is the
   * control that proves the probe discriminates.
   */
  it.effect("never admits a reader in the same round as the node that writes what it reads", () =>
    Effect.gen(function*() {
      const traced = (runId: string, plan: Plan.Plan) => {
        const trace: Array<string> = []
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) =>
            Effect.gen(function*() {
              trace.push(`start:${node.id}`)
              yield* Effect.yieldNow
              trace.push(`end:${node.id}`)
              return node.id
            })
        }
        return Effect.gen(function*() {
          yield* activate(runId)
          yield* Effect.provide(scheduler({ runId, executor }).run(plan), harness({ runId, executor }))
          return trace
        }).pipe(Effect.provide(TestStores.layer()))
      }

      const independent = yield* withCrypto(traced(
        "run-rw-control",
        yield* withCrypto(compile([draft("writer", { writes: ["shared.out"] }), draft("bystander")]))
      ))
      expect(independent).toEqual(["start:writer", "start:bystander", "end:writer", "end:bystander"])

      const ordered = yield* withCrypto(traced(
        "run-rw-ordered",
        yield* withCrypto(compile([
          draft("writer", { writes: ["shared.out"] }),
          draft("reader", { reads: ["shared.out"], writes: ["reader.out"] })
        ]))
      ))
      expect(ordered).toEqual(["start:writer", "end:writer", "start:reader", "end:reader"])
    }))
})

const conflict = () =>
  new WorkspaceSandbox.MaterializationConflict({
    paths: ["shared.out"],
    message: "the host moved under the transaction"
  })

describe("PlanScheduler conflict strategies", () => {
  it("recognizes live and rehydrated materialization conflicts", () => {
    const live = conflict()
    const rehydrated = { _tag: live._tag, paths: live.paths, message: live.message }
    expect(WorkspaceSandbox.isMaterializationConflict(live)).toBe(true)
    expect(WorkspaceSandbox.isMaterializationConflict(rehydrated)).toBe(true)
    expect(WorkspaceSandbox.isMaterializationConflict({ ...rehydrated, _tag: "different" })).toBe(false)
  })

  it.effect("delay/rebase replays a persisted conflict as a new attempt", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("replayed-racer")]))
      let dispatches = 0
      const executor: PlanScheduler.Executor = {
        execute: () =>
          Effect.sync(() => {
            dispatches = dispatches + 1
            return "landed"
          })
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-replayed-conflict")
          const node = plan.nodes[0]!
          const dispatchKey = yield* StepKey.dispatchIdentity({
            material: node.material,
            results: {},
            hermetic: {
              readSet: [],
              writeSet: ["replayed-racer.out"],
              boundaryMode: "hard"
            }
          })
          const attempts = yield* AttemptStore.AttemptStore
          const attemptId = {
            runId: "run-replayed-conflict",
            stepKeyDigest: sha256(dispatchKey),
            attempt: 1
          }
          const inserted = yield* attempts.put({
            ...attemptId,
            state: "running",
            startedAtMs: 1,
            meta: { tier: "sealed" }
          }, owner)
          /* v8 ignore next -- the activated deterministic store cannot reject its first attempt row */
          if (inserted._tag !== "Inserted") return yield* Effect.die(new Error("attempt seed was not inserted"))
          const live = conflict()
          const finished = yield* attempts.finish({
            ...attemptId,
            state: "failed",
            finishedAtMs: 2,
            error: {
              reasons: [{
                _tag: "Fail",
                error: { _tag: live._tag, paths: live.paths, message: live.message }
              }]
            },
            meta: { tier: "sealed" }
          }, owner)
          /* v8 ignore next -- the owner-fenced running row above has one valid terminal transition */
          if (finished._tag !== "Finished") return yield* Effect.die(new Error("attempt seed was not finished"))
          return yield* Effect.provide(
            scheduler({ runId: "run-replayed-conflict", executor }).run(plan),
            harness({ runId: "run-replayed-conflict", executor })
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )
      expect(report.settlements[0]).toMatchObject({ outcome: "built", attempts: 2, rebases: 1 })
      expect(dispatches).toBe(1)
    }))

  it.effect("delay/rebase re-keys a new attempt and lands within its bound", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("racer", { writes: ["shared.out"] })]))
      const attempts = yield* withCrypto(
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
    }))

  it.effect("delay/rebase is bounded — an exhausted budget asks reconciliation and fails", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("holder", { writes: ["shared.out"] }),
        draft("racer", { writes: ["shared.out"] })
      ]))
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) => node.id === "racer" ? Effect.fail(conflict()) : Effect.succeed(node.id)
      }
      const report = yield* withCrypto(
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
    }))

  it.effect("stop/merge stops the loser and routes both lanes through an appended merge node", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
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
      const { persisted, report } = yield* withCrypto(
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
    }))
})

describe("PlanScheduler reconciliation", () => {
  const deviating = (paths: ReadonlyArray<string>) => StepBoundary.layerTest({ changedPaths: paths })

  it.effect("attributes an identical-key deviation to the node that executed", () =>
    Effect.gen(function*() {
      const shared = {
        body: { action: "install" },
        writes: ["installed.out"],
        boundaryMode: "expected" as const
      }
      const plan = yield* withCrypto(compile([
        draft("install-first", shared),
        draft("install-twin", shared)
      ]))
      const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("installed") }
      const seen: Array<Reconciliation.Deviation> = []
      const recorder = Reconciliation.layer({
        onDeviation: (deviation) =>
          Effect.sync(() => {
            seen.push(deviation)
            return { _tag: "FactorOut", paths: deviation.paths, reason: "observed" } as const
          }),
        /* v8 ignore next -- identical successful dispatches never enter conflict reconciliation */
        onConflict: () => Effect.succeed({ _tag: "Fail", reason: "unused" } as const)
      })
      const { replayed, report } = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-identical-deviation")
          const service = scheduler({ runId: "run-identical-deviation", executor })
          const report = yield* service.run(plan)
          const replayed = yield* service.run(plan)
          return { replayed, report }
        }).pipe(
          Effect.provide(harness({
            runId: "run-identical-deviation",
            executor,
            boundary: deviating(["node_modules/.bin/tool"]),
            reconciliation: recorder
          })),
          Effect.provide(TestStores.layer())
        )
      )
      const built = report.settlements.find((settlement) => settlement.outcome === "built")!
      const clean = report.settlements.find((settlement) => settlement.outcome === "clean")!
      expect(replayed.settlements.every((settlement) => settlement.outcome === "clean")).toBe(true)
      expect(new Set(seen.map((deviation) => deviation.nodeId))).toEqual(new Set([built.nodeId]))
      expect(seen.map((deviation) => deviation.nodeId)).not.toContain(clean.nodeId)
    }))

  it.effect("gives the expected-set-deviation event its first consumer", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("loose", { writes: ["declared.out"], boundaryMode: "expected" })]))
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
      const report = yield* withCrypto(
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
    }))

  it.effect("the default reorders when the deviation names another node's declared write", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("writer", { writes: ["shared.out"] }),
        draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
        draft("later", { inputs: [{ _tag: "Pending", from: "writer" }], writes: ["later.out"] })
      ]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const report = yield* withCrypto(
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
    }))

  it.effect("the default fails a deviation no declaration explains", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("mystery", { boundaryMode: "expected" })]))
      const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("done") }
      const report = yield* withCrypto(
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
    }))

  it.effect("the default factors out two nodes that deviated identically", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("install-a", { boundaryMode: "expected" }),
        draft("install-b", { boundaryMode: "expected" })
      ]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const report = yield* withCrypto(
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
    }))

  it.effect("drains deviations past the first page of the journal", () =>
    Effect.gen(function*() {
      // The reconciliation seam reads the journal a page at a time. A wide round
      // journals more records than one page holds, and the last round has no
      // successor to pick up the remainder — so a deviation beyond the cursor
      // would never reach the seam at all. Filler records push the only real
      // deviation off the first page.
      const plan = yield* withCrypto(compile([draft("late", { boundaryMode: "expected" })]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const report = yield* withCrypto(
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
    }))
})

describe("PlanScheduler elaboration", () => {
  it.effect("appends a subgraph to the same plan and journals it", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const grown = yield* withCrypto(
        Plan.append(base, [draft("child", { inputs: [{ _tag: "Pending", from: "root" }] })])
      )
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const { events, report } = yield* withCrypto(
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
    }))

  it.effect("reports a store refusal as a typed scheduler error", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("root")]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-store-failure")
          const service = scheduler({ runId: "run-store-failure", executor })
          yield* service.record(plan)
          return yield* Effect.flip(service.append(plan))
        }).pipe(Effect.provide(harness({ runId: "run-store-failure", executor })), Effect.provide(TestStores.layer()))
      )
      expect(failure).toMatchObject({ code: "store_failed" })
    }))

  it.effect("self-interrupts when the run was reclaimed under it", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("root")]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const exit = yield* withCrypto(
        Effect.exit(scheduler({ runId: "run-zombie", executor }).record(plan)).pipe(
          Effect.provide(harness({ runId: "run-zombie", executor })),
          Effect.provide(TestStores.layer())
        )
      )
      // The run row was never claimed by this owner, so the fenced emit reports
      // `fence_lost` and the scheduler stops rather than driving a plan it no
      // longer owns.
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))

  it.effect("surfaces a host that cannot measure the plan's inputs", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("reader", { reads: ["absent.txt"] })]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("run-unmeasurable")
          return yield* Effect.provide(
            Effect.flip(scheduler({ runId: "run-unmeasurable", executor }).run(plan)),
            harness({ runId: "run-unmeasurable", executor, boundary: StepBoundary.layerTest({ supported: false }) })
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )
      expect(failure).toMatchObject({ code: "boundary_unavailable" })
    }))
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
          return {
            descriptor,
            readSnapshot: StepBoundary.exactReads(descriptor).map((entry) => ({ path: entry.path, digest }))
          }
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

  it.effect("journals a re-key when the measured inputs move under a rebase", () =>
    Effect.gen(function*() {
      // The node reads a path the plan also writes, so it is not pinned as a
      // source: each attempt re-measures it, which is exactly the case a
      // re-key has to describe.
      const plan = yield* withCrypto(compile([draft("racer", { reads: ["shared.out"], writes: ["shared.out"] })]))
      const { events, report } = yield* withCrypto(
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
    }))

  it.effect("reorders onto a writer that has not dispatched yet", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([
        draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
        draft("writer", { writes: ["shared.out"] })
      ]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const report = yield* withCrypto(
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
    }))

  it.effect("ignores journalled deviations it cannot attribute to a node of this plan", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("solo")]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const report = yield* withCrypto(
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
    }))

  it.effect("reports a journal failure that is not merely a lost fence as a store failure", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("solo")]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const failure = yield* withCrypto(
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
    }))

  it.effect("is reachable as a layer", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(compile([draft("solo")]))
      const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
      const report = yield* withCrypto(
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
    }))
})
