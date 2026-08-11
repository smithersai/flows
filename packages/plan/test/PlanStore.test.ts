import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { runPromise } from "./Crypto.ts"
import { compile, draft } from "./Plan.test.ts"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))

const withStore = <A, E>(
  use: (store: PlanStore.Service) => Effect.Effect<A, E, SqlClient.SqlClient>
): Promise<A> =>
  runPromise(
    Effect.flatMap(PlanStore.PlanStore, use).pipe(Effect.provide(stores)) as Effect.Effect<A, E, never>
  )

/** The message SQLite's `RAISE(ABORT, ...)` carried, through the SqlError. */
const raised = (error: unknown): string =>
  (error as { readonly reason?: { readonly cause?: { readonly message?: string } } }).reason?.cause?.message ??
    String(error)

const samplePlan = () =>
  compile([
    draft("root", { writes: ["out"] }),
    draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })
  ])

describe("PlanStore", () => {
  it("records a plan and reads it back node for node", async () => {
    const plan = await runPromise(samplePlan())
    const { read, recorded } = await withStore((store) =>
      Effect.gen(function*() {
        const recorded = yield* store.record(plan, 1)
        const read = yield* store.get(plan.planId)
        return { read, recorded }
      })
    )
    expect(recorded).toEqual({ _tag: "Recorded" })
    expect(Option.getOrThrow(read)).toEqual(plan)
  })

  it("is first-writer-wins: an identical re-record is not an error, a different one is a conflict", async () => {
    const plan = await runPromise(samplePlan())
    const other = await runPromise(compile([draft("root", { body: { seed: 9 } })]))
    const { conflict, same } = await withStore((store) =>
      Effect.gen(function*() {
        yield* store.record(plan, 1)
        const same = yield* store.record(plan, 2)
        const conflict = yield* store.record({ ...other, planId: plan.planId }, 3)
        return { conflict, same }
      })
    )
    expect(same).toEqual({ _tag: "ExistingSame" })
    expect(conflict).toEqual({ _tag: "Conflict", digest: plan.digest })
  })

  it("appends an elaborated subgraph and advances the digest", async () => {
    const base = await runPromise(samplePlan())
    const grown = await runPromise(Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })]))
    const read = await withStore((store) =>
      Effect.gen(function*() {
        yield* store.record(base, 1)
        yield* store.append(grown)
        return yield* store.get(base.planId)
      })
    )
    expect(Option.getOrThrow(read)).toEqual(grown)
  })

  it("returns none for a plan that was never recorded", async () => {
    expect(await withStore((store) => store.get("absent"))).toEqual(Option.none())
  })

  it("refuses to append to a plan that was never recorded, and leaves no orphan rows", async () => {
    const base = await runPromise(samplePlan())
    const grown = await runPromise(Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })]))
    const { failure, orphans } = await withStore((store) =>
      Effect.gen(function*() {
        // The UPDATE matches nothing while the node inserts succeed, so
        // without the check this wrote a generation of a plan that does not
        // exist — and the append-only triggers mean those rows could never be
        // taken back out again.
        const failure = yield* Effect.flip(store.append(grown))
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM flows_plan_nodes`
        return { failure, orphans: rows[0]!.n }
      })
    )
    expect(failure).toMatchObject({ code: "constraint" })
    expect(orphans).toBe(0)
  })

  it("refuses a value that is not a plan", async () => {
    const failure = await withStore((store) =>
      Effect.flip(store.record({ planId: "", flow: "f", generation: 0, baseDigest: "x", digest: "x", nodes: [] }, 1))
    )
    expect(failure).toMatchObject({ code: "invalid_plan" })
  })

  it("refuses an append that re-inserts a node id the plan already holds", async () => {
    const plan = await runPromise(samplePlan())
    const forged: Plan.Plan = {
      ...plan,
      generation: 1,
      nodes: [...plan.nodes, { ...plan.nodes[0]!, generation: 1 }]
    }
    const failure = await withStore((store) =>
      Effect.gen(function*() {
        yield* store.record(plan, 1)
        // `Plan.append` refuses this in memory; the primary key refuses it in
        // the database, so a caller that bypasses the compiler cannot rewrite
        // history either.
        return yield* Effect.flip(store.append(forged))
      })
    )
    expect(failure).toMatchObject({ code: "constraint" })
  })

  it("raises when a recorded node row is rewritten or deleted", async () => {
    const plan = await runPromise(samplePlan())
    const failures = await withStore((store) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* store.record(plan, 1)
        const update = yield* Effect.flip(sql`UPDATE flows_plan_nodes SET kind = 'agent'`)
        const remove = yield* Effect.flip(sql`DELETE FROM flows_plan_nodes`)
        const edge = yield* Effect.flip(sql`UPDATE flows_plan_edges SET to_node = 'x'`)
        const edgeDelete = yield* Effect.flip(sql`DELETE FROM flows_plan_edges`)
        const backwards = yield* Effect.flip(sql`UPDATE flows_plans SET generation = 0`)
        return [update, remove, edge, edgeDelete, backwards].map(raised)
      })
    )
    expect(failures.filter((message) => message.includes("append-only")).length).toBe(4)
    expect(failures[4]).toContain("a plan only grows")
  })

  it("reports an undecodable node row rather than returning a broken plan", async () => {
    const plan = await runPromise(samplePlan())
    const failure = await withStore((store) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* store.record(plan, 1)
        yield* sql`DROP TRIGGER flows_plan_nodes_append_only`
        yield* sql`UPDATE flows_plan_nodes SET node_json = '{"id":"broken"}'`
        return yield* Effect.flip(store.get(plan.planId))
      })
    )
    expect(failure).toMatchObject({ code: "decode_failed", message: expect.stringContaining("flows_plan_nodes") })
  })

  it("refuses a node the encoder cannot serialize", async () => {
    const plan = await runPromise(samplePlan())
    const forged: Plan.Plan = {
      ...plan,
      nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: 1n } }]
    }
    const failure = await withStore((store) => Effect.flip(store.record(forged, 1)))
    expect(failure).toMatchObject({ code: "invalid_plan" })
  })

  it("maps a missing table to a persistence failure", async () => {
    const failure = await withStore((store) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP TABLE flows_plans`
        return yield* Effect.flip(store.get("anything"))
      })
    )
    expect(failure).toMatchObject({ code: "persistence_failed" })
  })
})
