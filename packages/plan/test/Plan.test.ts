/**
 * Deterministic graph tests in the mould of Skyframe's `GraphTester`: a graph
 * is declared as data, compiled, and asserted on. Nothing here touches a
 * clock, a filesystem, or a network — `docs/specs/Concepts/Build Phases.md`
 * makes that a law, and a test that needed any of them would be evidence the
 * law was broken.
 */
import { describe, expect, it } from "vitest"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanDiff from "../src/PlanDiff.ts"
import { runFailure, runPromise } from "./Crypto.ts"

export const effects = (
  reads: ReadonlyArray<string>,
  writes: ReadonlyArray<string>
): Plan.NodeEffects => ({ reads, writes, boundaryMode: "hard" })

export const draft = (
  id: string,
  options: {
    readonly body?: unknown
    readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
    readonly reads?: ReadonlyArray<string>
    readonly writes?: ReadonlyArray<string>
  } & Omit<Plan.NodeDraft, "id" | "material" | "effects"> = {}
): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: options.body ?? { activity: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: effects(options.reads ?? [], options.writes ?? []),
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy })
})

export const compile = (nodes: ReadonlyArray<Plan.NodeDraft>, planId = "plan-1") =>
  Plan.compile({ planId, flow: "example/Build", nodes })

const keyOf = (plan: Plan.Plan, id: string) => plan.nodes.find((node) => node.id === id)!.key

describe("Plan.compile", () => {
  it("orders topologically, keys every node, and defaults its annotations", async () => {
    const plan = await runPromise(compile([
      draft("late", { inputs: [{ _tag: "Ref", from: "early", path: [] }] }),
      draft("early")
    ]))
    expect(plan.nodes.map((node) => node.id)).toEqual(["early", "late"])
    expect(plan.nodes.every((node) => node.key.startsWith("key1_"))).toBe(true)
    expect(plan.nodes[0]).toMatchObject({ kind: "step", priority: 0, strategy: "serialize", runtime: "delay-rebase" })
    expect(plan.digest).toBe(plan.baseDigest)
    expect(plan.generation).toBe(0)
  })

  it("re-keys the dependent cone and nothing else when a leaf's declaration changes", async () => {
    const before = await runPromise(compile([
      draft("source", { body: { seed: 1 } }),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
      draft("sibling")
    ]))
    const after = await runPromise(compile([
      draft("source", { body: { seed: 2 } }),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
      draft("sibling")
    ]))
    expect(keyOf(after, "source")).not.toBe(keyOf(before, "source"))
    expect(keyOf(after, "derived")).not.toBe(keyOf(before, "derived"))
    expect(keyOf(after, "sibling")).toBe(keyOf(before, "sibling"))
    expect(after.digest).not.toBe(before.digest)
  })

  it("renaming a node changes no key — ids are lookup addresses, never hashed", async () => {
    const left = await runPromise(compile([draft("a"), draft("b", { inputs: [{ _tag: "Pending", from: "a" }] })]))
    const right = await runPromise(compile([
      draft("renamed", { body: { activity: "a" } }),
      draft("b", { inputs: [{ _tag: "Pending", from: "renamed" }] })
    ]))
    expect(keyOf(right, "b")).toBe(keyOf(left, "b"))
  })

  it("serializes overlapping writers in declaration order without re-keying them", async () => {
    const disjoint = await runPromise(compile([draft("first", { writes: ["out"] }), draft("second")]))
    const plan = await runPromise(compile([
      draft("first", { writes: ["out", "log"] }),
      draft("second", { writes: ["out"] })
    ]))
    const second = plan.nodes.find((node) => node.id === "second")!
    expect(second.dependsOn).toEqual(["first"])
    expect(second.conflicts).toEqual([{
      with: "first",
      paths: ["out"],
      strategy: "serialize",
      runtime: "delay-rebase"
    }])
    expect(plan.nodes[0]!.conflicts).toEqual([{
      with: "second",
      paths: ["out"],
      strategy: "serialize",
      runtime: "delay-rebase"
    }])
    // The ordering edge is not key material: a serialized node computes the
    // same result, so it must keep its cache hit.
    expect(keyOf(plan, "second")).toBe(keyOf(disjoint, "second"))
  })

  it("gives both writers lane annotations when either asks for a lane", async () => {
    const plan = await runPromise(compile([
      draft("first", { writes: ["out"] }),
      draft("second", { writes: ["out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
    ]))
    expect(plan.nodes.map((node) => node.conflicts[0]?.strategy)).toEqual(["lane", "lane"])
    expect(plan.nodes.map((node) => node.conflicts[0]?.runtime)).toEqual(["stop-merge", "stop-merge"])
    // A lane pair gains no ordering edge — the lanes run concurrently.
    expect(plan.nodes.find((node) => node.id === "second")!.dependsOn).toEqual([])
  })

  it("refuses an overlap a declaration promised could not happen", async () => {
    const failure = await runFailure(compile([
      draft("first", { writes: ["out"], conflictStrategy: "fail" }),
      draft("second", { writes: ["out"] })
    ]))
    expect(failure).toMatchObject({ code: "overlap_forbidden" })
  })

  it("does not call writers a dependency path already orders a conflict", async () => {
    const plan = await runPromise(compile([
      draft("first", { writes: ["out"] }),
      draft("middle", { inputs: [{ _tag: "Ref", from: "first", path: [] }] }),
      draft("second", { writes: ["out"], inputs: [{ _tag: "Ref", from: "middle", path: [] }] })
    ]))
    expect(plan.nodes.flatMap((node) => node.conflicts)).toEqual([])
  })

  it("rejects a cycle, an unknown dependency, and a duplicate id", async () => {
    expect(
      await runFailure(compile([
        draft("a", { inputs: [{ _tag: "Ref", from: "b", path: [] }] }),
        draft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })
      ]))
    ).toMatchObject({ code: "cycle" })
    expect(await runFailure(compile([draft("a", { inputs: [{ _tag: "Pending", from: "ghost" }] })])))
      .toMatchObject({ code: "unknown_dependency" })
    expect(await runFailure(compile([draft("a"), draft("a")]))).toMatchObject({ code: "duplicate_node" })
  })
})

describe("Plan.append", () => {
  it("grows the plan without rewriting a single recorded node", async () => {
    const base = await runPromise(compile([draft("root", { writes: ["out"] })]))
    const grown = await runPromise(
      Plan.append(base, [draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })])
    )
    expect(grown.nodes[0]).toEqual(base.nodes[0])
    expect(grown.generation).toBe(1)
    expect(grown.baseDigest).toBe(base.baseDigest)
    expect(grown.digest).not.toBe(base.digest)
    expect(Plan.generationNodes(grown).map((node) => node.id)).toEqual(["child"])
    expect(grown.nodes[1]!.generation).toBe(1)
  })

  it("annotates a conflict discovered during elaboration on the new node only", async () => {
    const base = await runPromise(compile([draft("root", { writes: ["out"] })]))
    const grown = await runPromise(Plan.append(base, [draft("late", { writes: ["out"] })]))
    expect(grown.nodes[0]!.conflicts).toEqual([])
    expect(grown.nodes[1]!.conflicts).toEqual([{
      with: "root",
      paths: ["out"],
      strategy: "serialize",
      runtime: "delay-rebase"
    }])
    expect(grown.nodes[1]!.dependsOn).toEqual(["root"])
  })

  it("refuses to append a node id the plan already holds", async () => {
    const base = await runPromise(compile([draft("root")]))
    expect(await runFailure(Plan.append(base, [draft("root")]))).toMatchObject({ code: "duplicate_node" })
  })
})

describe("PlanDiff.diff", () => {
  it("reports added, removed, unchanged, and re-keyed nodes with attribution", async () => {
    const before = await runPromise(compile([
      draft("source", { body: { seed: 1 } }),
      draft("derived", { inputs: [{ _tag: "Pending", from: "source" }] }),
      draft("dropped")
    ]))
    const after = await runPromise(compile([
      draft("source", { body: { seed: 2 } }),
      draft("derived", { inputs: [{ _tag: "Pending", from: "source" }] }),
      draft("fresh")
    ]))
    const result = PlanDiff.diff(before, after)
    expect(result.added).toEqual(["fresh"])
    expect(result.removed).toEqual(["dropped"])
    expect(result.unchanged).toEqual([])
    expect(result.rekeyed.map((entry) => entry.id).sort()).toEqual(["derived", "source"])
    expect(result.rekeyed.find((entry) => entry.id === "source")!.changed).toEqual(["body"])
    // The dependent re-keyed because its upstream did, and the report says so.
    expect(result.rekeyed.find((entry) => entry.id === "derived")!.changed).toEqual(["input[0]"])
  })

  it("attributes every declaration field that can move a key", async () => {
    const material = (overrides: Partial<KeyMaterial.KeyMaterial>): Plan.NodeDraft => ({
      id: "node",
      material: {
        version: KeyMaterial.version,
        kind: "sealed",
        body: 1,
        inputs: [{ _tag: "Literal", value: 1 }],
        layers: ["a"],
        capabilities: ["fs:read"],
        effects: { net: false },
        ...overrides
      },
      effects: effects([], [])
    })
    const before = await runPromise(compile([material({})]))
    const after = await runPromise(compile([
      material({
        body: 2,
        layers: ["b"],
        capabilities: ["fs:write"],
        effects: { net: true },
        inputs: [{ _tag: "Literal", value: 2 }, { _tag: "Literal", value: 3 }]
      })
    ]))
    expect(PlanDiff.diff(before, after).rekeyed[0]!.changed).toEqual([
      "body",
      "layers",
      "capabilities",
      "effects",
      "input[0]",
      "input[1]"
    ])
  })

  it("says nothing changed when nothing did", async () => {
    const plan = await runPromise(compile([draft("only")]))
    expect(PlanDiff.diff(plan, plan)).toEqual({ added: [], removed: [], rekeyed: [], unchanged: ["only"] })
  })

  it("reports a material version bump as its own attribution", async () => {
    const before = await runPromise(compile([draft("node")]))
    const after: Plan.Plan = {
      ...before,
      nodes: [{
        ...before.nodes[0]!,
        key: `key1_${"0".repeat(64)}`,
        material: {
          ...before.nodes[0]!.material,
          version: "flows/key-material/v2" as KeyMaterial.KeyMaterial["version"]
        }
      }]
    }
    expect(PlanDiff.diff(before, after).rekeyed[0]!.changed).toEqual(["version"])
  })

  it("does not blame an unchanged upstream reference for a local edit", async () => {
    const graph = (body: unknown) => [
      draft("source"),
      draft("derived", { body, inputs: [{ _tag: "Ref", from: "source", path: [] }] })
    ]
    // Two-key bodies declared in opposite orders: the attribution report is
    // order-insensitive, so only the value change is blamed.
    const before = await runPromise(compile(graph({ v: 1, w: 0 })))
    const after = await runPromise(compile(graph({ w: 0, v: 2 })))
    expect(PlanDiff.diff(before, after).rekeyed).toEqual([
      { id: "derived", from: keyOf(before, "derived"), to: keyOf(after, "derived"), changed: ["body"] }
    ])
  })

  it("compares structurally rather than by key order", async () => {
    const node = (body: unknown): Plan.NodeDraft => ({
      id: "node",
      material: {
        version: KeyMaterial.version,
        kind: "sealed",
        body,
        inputs: [],
        layers: [],
        capabilities: []
      },
      effects: effects([], [])
    })
    const before = await runPromise(compile([node({ a: 1, b: [1, "x", null] })]))
    const reordered = await runPromise(compile([node({ b: [1, "x", null], a: 1 })]))
    expect(PlanDiff.diff(before, reordered).unchanged).toEqual(["node"])
  })
})
