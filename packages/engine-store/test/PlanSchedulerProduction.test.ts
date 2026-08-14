/**
 * The acceptance test for the whole lane, under the PRODUCTION composition:
 * the filesystem-backed `StepBoundary` and the filesystem-backed
 * `WorkspaceSandbox` over a real temporary workspace. No `layerTest` anywhere.
 *
 * A plan is compiled and persisted, the scheduler drives it, one input file is
 * edited, and the same plan is driven again. The promise Bazel makes and this
 * repository has been claiming since `Step Keys` was written is that only the
 * cone below the edit re-runs and every unchanged branch is a cache hit. This
 * is where that stops being a claim.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as ArtifactStore from "@smthrs/artifacts-next/ArtifactStore"
import { Jj } from "@smthrs/kernel-next"
import * as KernelWorkspace from "@smthrs/kernel-next/Workspace"
import { KeyMaterial, Plan } from "@smthrs/plan-next"
import * as FileSet from "@smthrs/plan-next/FileSet"
import { type Ownership, RunStore } from "@smthrs/run-store-next"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "plan-host", pid: 55, nonce: "plan-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "plan-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** The production composition: real filesystem, real boundary, real sandbox. */
const production = (root: string) => {
  const artifacts = ArtifactStore.layerFileSystem({ directory: join(root, ".flows/objects") }).pipe(
    Layer.provideMerge(NodeFileSystem.layer)
  )
  return Layer.mergeAll(
    StepBoundary.layer.pipe(Layer.provide(artifacts)),
    jjLayer,
    StepSandbox.layer.pipe(
      Layer.provide(artifacts),
      Layer.provide(KernelWorkspace.layer(root))
    )
  ).pipe(Layer.provideMerge(artifacts))
}

const write = (path: string, content: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(join(path, ".."), { recursive: true })
    yield* fs.writeFileString(path, content)
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie)

const read = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.orDie
  )

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

/**
 * An ordinary body: it reads its declared inputs and writes its declared
 * output. It knows nothing about plans, sandboxes, or keys — which is the
 * point of the executor seam.
 */
const renderer = (ran: Array<string>): PlanScheduler.Executor => ({
  execute: ({ boundary, node }) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const parts: Array<string> = []
      for (const entry of StepBoundary.exactReads(boundary)) parts.push(yield* fs.readFileString(entry.path))
      const output = FileSet.expand(node.effects.writes)[0]!
      if (typeof output !== "string") return yield* Effect.die(new Error("renderer expects an exact output"))
      yield* fs.makeDirectory(join(output, ".."), { recursive: true })
      yield* fs.writeFileString(output, `${node.id}(${parts.join("+")})`)
      ran.push(node.id)
      return { bytes: parts.join("+").length }
    }).pipe(Effect.orDie) as unknown as Effect.Effect<unknown, unknown>
})

const graph = (root: string): ReadonlyArray<Plan.NodeDraft> => [
  {
    id: "render-a",
    material: {
      version: KeyMaterial.version,
      kind: "sealed" as const,
      body: { action: "render" },
      inputs: [{ _tag: "Literal" as const, value: "a" }],
      layers: [],
      capabilities: []
    },
    effects: {
      reads: [join(root, "src/a.txt")],
      writes: [join(root, "out/a.txt")],
      boundaryMode: "hard" as const
    }
  },
  {
    id: "render-b",
    material: {
      version: KeyMaterial.version,
      kind: "sealed" as const,
      body: { action: "render" },
      inputs: [{ _tag: "Literal" as const, value: "b" }],
      layers: [],
      capabilities: []
    },
    effects: {
      reads: [join(root, "src/b.txt")],
      writes: [join(root, "out/b.txt")],
      boundaryMode: "hard" as const
    }
  },
  {
    id: "combine",
    material: {
      version: KeyMaterial.version,
      kind: "sealed" as const,
      body: { action: "combine" },
      inputs: [
        { _tag: "Ref" as const, from: "render-a", path: [] },
        { _tag: "Ref" as const, from: "render-b", path: [] }
      ],
      layers: [],
      capabilities: []
    },
    effects: {
      reads: [join(root, "out/a.txt"), join(root, "out/b.txt")],
      writes: [join(root, "out/all.txt")],
      boundaryMode: "hard" as const
    }
  }
]

const outcomes = (report: PlanScheduler.Report) =>
  Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.outcome]))

describe("a persisted plan driven end to end under the production composition", () => {
  it("re-runs only the cone below an edited input; every unchanged branch is a cache hit", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-plan-"))
    const plan = await runPromise(Plan.compile({ planId: "prod-plan", flow: "example/Render", nodes: graph(root) }))
    const first: Array<string> = []
    const second: Array<string> = []

    const stores = TestStores.layer()
    const program = Effect.gen(function*() {
      yield* write(join(root, "src/a.txt"), "alpha")
      yield* write(join(root, "src/b.txt"), "beta")

      yield* activate("prod-run-1")
      const one = PlanScheduler.make({ runId: "prod-run-1", owner, sourceId: "plan/prod-run-1" })
      const recorded = yield* one.record(plan)
      const before = yield* Effect.provide(
        one.run(plan),
        Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(first)))
      )

      // The world moves: one source file is edited between runs. Nothing else
      // changes — same plan value, same keys, same declarations.
      yield* write(join(root, "src/a.txt"), "ALPHA")

      yield* activate("prod-run-2")
      const two = PlanScheduler.make({ runId: "prod-run-2", owner, sourceId: "plan/prod-run-2" })
      const after = yield* Effect.provide(
        two.run(plan),
        Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(second)))
      )
      const events = yield* JournalRecords.entries("prod-run-2", undefined, 512)
      return { after, before, events, recorded }
    }).pipe(Effect.provide(stores))

    const { after, before, events, recorded } = await runPromise(program)

    expect(recorded).toEqual({ _tag: "Recorded" })
    expect(outcomes(before)).toEqual({ "render-a": "built", "render-b": "built", combine: "built" })
    expect(first.sort()).toEqual(["combine", "render-a", "render-b"])

    // THE HEADLINE. `render-b` reads a file nothing touched, so its dispatch
    // key is unchanged and the cross-run cache serves it: it never executed in
    // run 2. `render-a` re-keyed because the host measured different bytes,
    // and `combine` re-keyed because the file `render-a` produced changed.
    expect(outcomes(after)).toEqual({ "render-a": "built", "render-b": "clean", combine: "built" })
    expect(second.sort()).toEqual(["combine", "render-a"])

    // The workspace holds what the second run computed, copied back through
    // the sandbox's materialize.
    expect(await runPromise(read(join(root, "out/a.txt")))).toBe("render-a(ALPHA)")
    expect(await runPromise(read(join(root, "out/all.txt")))).toBe("combine(render-a(ALPHA)+render-b(beta))")

    // And the journal explains it: a cache hit for the clean node, node
    // outcomes for all three.
    const settled = events.entries.filter((entry) => entry.eventType === "flows.engine.node-settled")
    expect(settled.map((entry) => (entry.payload as { nodeId: string }).nodeId).sort()).toEqual([
      "combine",
      "render-a",
      "render-b"
    ])
    expect(
      events.entries.some((entry) =>
        entry.eventType === "flows.engine.cache-provenance" &&
        (entry.payload as { action?: string }).action === undefined
      )
    ).toBe(true)
  })

  it("pins a source-glob expansion once per run and re-keys when a new file matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-plan-glob-"))
    const output = join(root, "out/glob.txt")
    const plan = await runPromise(Plan.compile({
      planId: "prod-glob-plan",
      flow: "example/Glob",
      nodes: [{
        id: "render-glob",
        material: {
          version: KeyMaterial.version,
          kind: "sealed",
          body: { action: "render-glob" },
          inputs: [],
          layers: [],
          capabilities: []
        },
        effects: {
          reads: [{ _tag: "Glob", include: [`${root}/src/*.txt`] }],
          writes: [output],
          boundaryMode: "hard"
        }
      }]
    }))
    const stores = TestStores.layer()
    const runs: Array<string> = []
    const program = Effect.gen(function*() {
      yield* write(join(root, "src/a.txt"), "a")
      yield* activate("prod-glob-1")
      const first = yield* Effect.provide(
        PlanScheduler.make({ runId: "prod-glob-1", owner, sourceId: "glob/1" }).run(plan),
        Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(runs)))
      )
      yield* write(join(root, "src/b.txt"), "b")
      yield* activate("prod-glob-2")
      const second = yield* Effect.provide(
        PlanScheduler.make({ runId: "prod-glob-2", owner, sourceId: "glob/2" }).run(plan),
        Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(runs)))
      )
      return { first, second }
    }).pipe(Effect.provide(stores))
    const result = await runPromise(program)
    expect(outcomes(result.first)).toEqual({ "render-glob": "built" })
    expect(outcomes(result.second)).toEqual({ "render-glob": "built" })
    expect(runs).toEqual(["render-glob", "render-glob"])
    expect(await runPromise(read(output))).toBe("render-glob(a+b)")
  })
})
