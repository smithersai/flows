/**
 * The four probabilistic-selection laws, asserted through the scheduler the
 * way the PlanScheduler suite asserts evaluation: the graph is declared as
 * data, driven, and asserted on. The standard fixture is the spec's worked
 * example — `build` feeds `engine-tests`, `lint-docs` stands alone — so the
 * sinks are exactly the two leaves and `build` is the node no verdict may
 * touch.
 */
import { Journal } from "@smthrs/journal-next"
import { Jj } from "@smthrs/kernel-next"
import { KeyMaterial, Plan } from "@smthrs/plan-next"
import { type Ownership, RunStore } from "@smthrs/run-store-next"
import { CacheStore } from "@smthrs/step-cache-next"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Selection from "../src/Selection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "selection-host", pid: 47, nonce: "selection-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "selection-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

interface DraftOptions {
  readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
}

const draft = (id: string, options: DraftOptions = {}): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: [],
    writes: [`${id}.out`],
    boundaryMode: "hard"
  }
})

/**
 * The spec's worked example: `engine-tests` consumes `build`, so the sinks
 * are `engine-tests` and `lint-docs` and the one non-sink is `build`.
 */
const reviewGraph = () => [
  draft("build"),
  draft("engine-tests", { inputs: [{ _tag: "Pending", from: "build" }] }),
  draft("lint-docs")
]

const compile = (nodes: ReadonlyArray<Plan.NodeDraft>) =>
  Plan.compile({ planId: "plan-1", flow: "example/Review", nodes })

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

const edge = (overrides: Partial<Selection.SuspectedEdge> = {}): Selection.SuspectedEdge => ({
  scope: "packages/engine/**",
  affects: "lint-docs",
  confidence: 0.03,
  validFromMs: 0,
  evidence: ["merges:41-of-50"],
  ...overrides
})

const beliefs = (...edges: Array<Selection.SuspectedEdge>): Selection.BeliefSnapshot => ({
  pinnedAtMs: 1_000,
  edges
})

const changed = ["packages/engine/src/PlanScheduler.ts"]

const policy: Selection.Policy = { deferBelow: 0.05 }

interface Harness {
  readonly executor: PlanScheduler.Executor
  readonly selection?: Layer.Layer<Selection.Selection> | undefined
}

const harness = (options: Harness) =>
  Layer.mergeAll(
    StepBoundary.layerTest(),
    jjLayer,
    PlanScheduler.layerExecutor(options.executor),
    ...(options.selection === undefined ? [] : [options.selection])
  )

interface DriveOptions {
  readonly runId: string
  readonly selection?: Layer.Layer<Selection.Selection> | undefined
  readonly options?: PlanScheduler.Options["selection"] | undefined
  /** Dispatch keys to probe the cache for, beyond the settlements' own. */
  readonly probe?: ReadonlyArray<string> | undefined
}

/**
 * Drives the plan in a fresh store bundle and returns everything the laws
 * assert on: outcomes, dispatch keys, the cache rows those keys address, the
 * executed node ids, and the run's journal. Bundles are isolated, and every
 * fixture in them is deterministic, so two drives of the same plan are
 * comparable byte for byte — which is exactly what law 1 asserts.
 */
const drive = (plan: Plan.Plan, options: DriveOptions) =>
  Effect.gen(function*() {
    const executed: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          executed.push(node.id)
          return { ran: node.id }
        })
    }
    yield* activate(options.runId)
    const service = PlanScheduler.make({
      runId: options.runId,
      owner,
      sourceId: `scheduler/${options.runId}`,
      ...(options.options === undefined ? {} : { selection: options.options })
    })
    const report = yield* Effect.provide(
      service.run(plan),
      harness({ executor, selection: options.selection })
    )
    const cache = yield* CacheStore.CacheStore
    const rows: Record<string, { keyDigest: string; result: unknown } | null> = {}
    for (const settlement of report.settlements) {
      if (settlement.dispatchKey === "") {
        rows[settlement.nodeId] = null
        continue
      }
      const row = yield* cache.get(sha256(settlement.dispatchKey))
      rows[settlement.nodeId] = Option.isNone(row)
        ? null
        : { keyDigest: row.value.keyDigest, result: row.value.result }
    }
    const probed: Record<string, boolean> = {}
    for (const key of options.probe ?? []) {
      probed[key] = Option.isSome(yield* cache.get(sha256(key)))
    }
    const events = yield* JournalRecords.entries(options.runId, undefined, 512)
    return { events: events.entries, executed, probed, report, rows }
  }).pipe(Effect.provide(TestStores.layer()))

describe("Selection laws through the scheduler", () => {
  it("changes nothing when nobody opted in — no layer, no options, no selection records", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    const result = await runPromise(drive(plan, { runId: "run-default" }))
    expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
    expect(result.events.some((entry) => entry.eventType.startsWith("flows.engine.selection-"))).toBe(false)
  })

  it("law 1: admitted work is byte-identical under layerNoop and layerHeuristic — same keys, same cache rows", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    // Confidence 0.9 clears the threshold, so the heuristic admits the sink
    // the edge names: both drives must produce the same everything.
    const selection = { changed, beliefs: beliefs(edge({ confidence: 0.9 })), policy }
    const noop = await runPromise(
      drive(plan, { runId: "run-law1-noop", selection: Selection.layerNoop, options: selection })
    )
    const heuristic = await runPromise(
      drive(plan, { runId: "run-law1-heuristic", selection: Selection.layerHeuristic, options: selection })
    )
    expect(outcomes(noop.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
    expect(outcomes(heuristic.report)).toEqual(outcomes(noop.report))
    const keys = (report: PlanScheduler.Report) =>
      Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.dispatchKey]))
    expect(keys(heuristic.report)).toEqual(keys(noop.report))
    expect(Object.values(noop.rows).every((row) => row !== null)).toBe(true)
    expect(heuristic.rows).toEqual(noop.rows)
  })

  it("law 2: deferred is not passed — no execution, no cache row, a journaled debt distinct from skipped and clean", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    const selection = { changed, beliefs: beliefs(edge()), policy }
    // The control drive admits everything, which pins the dispatch key the
    // deferred node WOULD have been recorded under — keys are deterministic
    // across bundles, which is what law 1 just proved.
    const control = await runPromise(drive(plan, { runId: "run-law2-control", options: selection }))
    expect(outcomes(control.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
    const lintKey = control.report.settlements.find((settlement) => settlement.nodeId === "lint-docs")!.dispatchKey
    expect(control.rows["lint-docs"]).not.toBeNull()

    const deferred = await runPromise(
      drive(plan, {
        runId: "run-law2-defer",
        selection: Selection.layerHeuristic,
        options: selection,
        probe: [lintKey]
      })
    )
    expect(outcomes(deferred.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "deferred" })
    expect(deferred.executed).not.toContain("lint-docs")
    expect(deferred.report.settlements.find((settlement) => settlement.nodeId === "lint-docs")).toMatchObject({
      attempts: 0,
      dispatchKey: "",
      outcome: "deferred"
    })
    // No cache row under the key the work would have carried: the deferral
    // wrote nothing the cache could ever serve as passed.
    expect(deferred.probed[lintKey]).toBe(false)
    const debts = deferred.events.filter((entry) => entry.eventType === "flows.engine.selection-deferred")
    expect(debts).toHaveLength(1)
    expect(debts[0]?.payload).toMatchObject({
      edge: { affects: "lint-docs", scope: "packages/engine/**" },
      likelihood: 0.03,
      nodeId: "lint-docs",
      planKey: plan.nodes.find((node) => node.id === "lint-docs")!.key
    })
  })

  it("law 3: only sinks are offered, and a verdict naming a non-sink is ignored and journaled", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    const offered: Array<ReadonlyArray<Selection.Candidate>> = []
    // A rogue selector: it records what it was offered, then defers `build`,
    // which the plan needs — the law says the guess cannot remove it — and
    // proposes a node the plan already contains.
    const rogue = Selection.layer(Selection.make({
      select: (input) =>
        Effect.sync(() => {
          offered.push(input.sinks)
          const verdicts: Array<Selection.Selected> = [
            { nodeId: "build", verdict: { _tag: "Defer", edge: edge({ affects: "build" }), likelihood: 0.01 } },
            {
              nodeId: "build",
              verdict: { _tag: "Propose", flow: "build", edge: edge({ affects: "build" }), confidence: 0.5 }
            },
            ...input.sinks.map((candidate): Selection.Selected => ({
              nodeId: candidate.nodeId,
              verdict: { _tag: "Admit" }
            }))
          ]
          return verdicts
        })
    }))
    const result = await runPromise(
      drive(plan, { runId: "run-law3", selection: rogue, options: { changed, beliefs: beliefs(), policy } })
    )
    expect(offered).toHaveLength(1)
    expect(offered[0]!.map((candidate) => candidate.nodeId)).toEqual(["engine-tests", "lint-docs"])
    expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
    const observations = result.events.filter((entry) => entry.eventType === "flows.engine.selection-inconsistent")
    expect(observations).toHaveLength(2)
    expect(observations[0]?.payload).toMatchObject({
      nodeId: "build",
      reason: "not-a-deferrable-sink",
      verdict: "Defer"
    })
    expect(observations[1]?.payload).toMatchObject({
      nodeId: "build",
      reason: "proposes-a-present-node",
      verdict: "Propose"
    })
    expect(result.events.some((entry) => entry.eventType === "flows.engine.selection-proposed")).toBe(false)
  })

  it("law 4: the full override restores full execution and journals itself", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    const result = await runPromise(
      drive(plan, {
        runId: "run-law4-full",
        selection: Selection.layerHeuristic,
        options: { changed, beliefs: beliefs(edge()), policy, full: true }
      })
    )
    expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
    expect(result.events.some((entry) => entry.eventType === "flows.engine.selection-overridden")).toBe(true)
    expect(result.events.some((entry) => entry.eventType === "flows.engine.selection-deferred")).toBe(false)
  })

  it("journals a proposal for a flow the plan cannot see, and appends nothing", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    const result = await runPromise(
      drive(plan, {
        runId: "run-propose",
        selection: Selection.layerHeuristic,
        options: { changed, beliefs: beliefs(edge({ affects: "update-engine-docs", confidence: 0.82 })), policy }
      })
    )
    expect(outcomes(result.report)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "built" })
    expect(result.report.appended).toEqual([])
    const proposals = result.events.filter((entry) => entry.eventType === "flows.engine.selection-proposed")
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.payload).toMatchObject({
      confidence: 0.82,
      edge: { scope: "packages/engine/**" },
      flow: "update-engine-docs"
    })
  })
})

describe("Selection.layerHeuristic", () => {
  const heuristic = Selection.makeHeuristic()

  const input = (overrides: Partial<Selection.Input> = {}): Selection.Input => ({
    changed,
    sinks: [{ nodeId: "lint-docs", planKey: "key-lint" }],
    present: ["example/Review", "build", "engine-tests", "lint-docs"],
    beliefs: beliefs(edge()),
    policy,
    ...overrides
  })

  it("defers a sink whose best likelihood is below the threshold", async () => {
    const verdicts = await runPromise(heuristic.select(input()))
    expect(verdicts).toEqual([{
      nodeId: "lint-docs",
      verdict: { _tag: "Defer", edge: edge(), likelihood: 0.03 }
    }])
  })

  it("admits at exactly deferBelow — the threshold is strict", async () => {
    const verdicts = await runPromise(heuristic.select(input({ beliefs: beliefs(edge({ confidence: 0.05 })) })))
    expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
  })

  it("admits a sink no live edge names", async () => {
    const verdicts = await runPromise(heuristic.select(input({ beliefs: beliefs(edge({ affects: "engine-tests" })) })))
    expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
  })

  it("judges by the BEST likelihood among matching edges", async () => {
    const confident = await runPromise(heuristic.select(input({
      beliefs: beliefs(edge({ confidence: 0.02 }), edge({ confidence: 0.9 }))
    })))
    expect(confident).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
    const timid = await runPromise(heuristic.select(input({
      beliefs: beliefs(edge({ confidence: 0.02 }), edge({ confidence: 0.04 }), edge({ confidence: 0.01 }))
    })))
    expect(timid).toEqual([{
      nodeId: "lint-docs",
      verdict: { _tag: "Defer", edge: edge({ confidence: 0.04 }), likelihood: 0.04 }
    }])
  })

  it("matches scopes as path globs — `**` crosses separators, `*` and `?` do not", async () => {
    const verdictFor = async (scope: string) =>
      (await runPromise(heuristic.select(input({ beliefs: beliefs(edge({ scope })) }))))[0]!.verdict._tag
    // The changed path is packages/engine/src/PlanScheduler.ts throughout: a
    // matching scope makes the low-confidence edge live, which defers.
    expect(await verdictFor("packages/engine/**")).toBe("Defer")
    expect(await verdictFor("packages/*/src/PlanScheduler.ts")).toBe("Defer")
    expect(await verdictFor("packages/engine/src/PlanScheduler.t?")).toBe("Defer")
    expect(await verdictFor("packages/engine/src/PlanScheduler.ts")).toBe("Defer")
    expect(await verdictFor("packages/*.ts")).toBe("Admit")
    expect(await verdictFor("packages/engine/src")).toBe("Admit")
  })

  it("ignores an edge that is not yet valid at the snapshot's pin", async () => {
    const verdicts = await runPromise(heuristic.select(input({
      beliefs: beliefs(edge({ validFromMs: 5_000 }), edge({ affects: "docs-only", validFromMs: 5_000 }))
    })))
    expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
  })

  it("proposes a flow the plan does not contain, once, under the highest-confidence edge", async () => {
    const verdicts = await runPromise(heuristic.select(input({
      beliefs: beliefs(
        edge({ affects: "update-engine-docs", confidence: 0.2 }),
        edge({ affects: "update-engine-docs", confidence: 0.7 }),
        edge({ affects: "update-engine-docs", confidence: 0.4 })
      )
    })))
    expect(verdicts).toEqual([
      { nodeId: "lint-docs", verdict: { _tag: "Admit" } },
      {
        nodeId: "update-engine-docs",
        verdict: {
          _tag: "Propose",
          confidence: 0.7,
          edge: edge({ affects: "update-engine-docs", confidence: 0.7 }),
          flow: "update-engine-docs"
        }
      }
    ])
  })

  it("never proposes a name the plan already accounts for", async () => {
    const verdicts = await runPromise(heuristic.select(input({
      beliefs: beliefs(edge({ affects: "build", confidence: 0.9 }), edge({ affects: "example/Review" }))
    })))
    expect(verdicts).toEqual([{ nodeId: "lint-docs", verdict: { _tag: "Admit" } }])
  })
})

describe("Selection.debt", () => {
  it("round-trips: a deferral is owed until a guess-free run repays it", async () => {
    const plan = await runPromise(compile(reviewGraph()))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
    const program = Effect.gen(function*() {
      yield* activate("run-debt")
      const guessing = PlanScheduler.make({
        runId: "run-debt",
        owner,
        sourceId: "scheduler/run-debt",
        selection: { changed, beliefs: beliefs(edge()), policy }
      })
      const first = yield* Effect.provide(
        guessing.run(plan),
        harness({ executor, selection: Selection.layerHeuristic })
      )
      const owedAfterFirst = yield* Selection.debt("run-debt")
      // The follow-up is the guess-free full pass: same run, same plan,
      // selection forced full. Cached branches stay clean; only the debt runs.
      const repaying = PlanScheduler.make({
        runId: "run-debt",
        owner,
        sourceId: "scheduler/run-debt-full",
        selection: { changed, beliefs: beliefs(edge()), policy, full: true }
      })
      const second = yield* Effect.provide(
        repaying.run(plan),
        harness({ executor, selection: Selection.layerHeuristic })
      )
      const owedAfterSecond = yield* Selection.debt("run-debt")
      const events = yield* JournalRecords.entries("run-debt", undefined, 512)
      const recordedAt = events.entries.find((entry) => entry.eventType === "flows.engine.selection-deferred")!.seq
      return { first, owedAfterFirst, owedAfterSecond, recordedAt, second }
    }).pipe(Effect.provide(TestStores.layer()))

    const { first, owedAfterFirst, owedAfterSecond, recordedAt, second } = await runPromise(program)
    expect(outcomes(first)).toEqual({ build: "built", "engine-tests": "built", "lint-docs": "deferred" })
    expect(owedAfterFirst).toHaveLength(1)
    expect(owedAfterFirst[0]).toMatchObject({
      edge: { affects: "lint-docs" },
      likelihood: 0.03,
      nodeId: "lint-docs",
      planId: "plan-1",
      planKey: plan.nodes.find((node) => node.id === "lint-docs")!.key
    })
    // The provenance points at the journal record itself.
    expect(owedAfterFirst[0]!.seq).toBe(recordedAt)
    expect(outcomes(second)).toEqual({ build: "clean", "engine-tests": "clean", "lint-docs": "built" })
    expect(owedAfterSecond).toEqual([])
  })

  it("skips records it cannot decode and reads past the first page of the journal", async () => {
    // The fold reads the journal a page at a time, and nothing follows it to
    // pick up a deferral a single page left behind — so filler records push
    // the only real one past page one, and malformed records of both event
    // types prove an undecodable payload is skipped, not a crash.
    const plan = await runPromise(compile(reviewGraph()))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
    const program = Effect.gen(function*() {
      yield* activate("run-debt-paged")
      const journal = yield* Journal.Journal
      const at = (sourceId: string) => ({ runId: "run-debt-paged", lineageId: "run-debt-paged/root", sourceId })
      yield* Effect.forEach(
        Array.from({ length: 600 }, (_, index) => index),
        (index) => journal.emitDurable(JournalRecords.runDecision(at(`filler/${index}`), { index }), owner),
        { discard: true }
      )
      yield* journal.emitDurable(JournalRecords.selectionDeferred(at("malformed/deferred"), {}), owner)
      yield* journal.emitDurable(JournalRecords.nodeSettled(at("malformed/settled"), {}), owner)
      const service = PlanScheduler.make({
        runId: "run-debt-paged",
        owner,
        sourceId: "scheduler/run-debt-paged",
        selection: { changed, beliefs: beliefs(edge()), policy }
      })
      yield* Effect.provide(service.run(plan), harness({ executor, selection: Selection.layerHeuristic }))
      return yield* Selection.debt("run-debt-paged")
    }).pipe(Effect.provide(TestStores.layer()))
    const owed = await runPromise(program)
    expect(owed).toHaveLength(1)
    expect(owed[0]).toMatchObject({ nodeId: "lint-docs" })
  })
})
