import { Database, TestDatabase } from "@smithers/database"
import { Migrations } from "@smithers/journal"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * The durable run-parent DAG (issues #40/#41) backs cross-owner cycle
 * arbitration: both implementations must agree on first-writer-wins, on the
 * store-global insertion order, and on withdrawal.
 */
interface Harness {
  readonly label: string
  readonly run: <A>(
    body: (state: DurableEngineState.Service) => Effect.Effect<A, never, never>
  ) => Promise<A>
}

const sqlHarness: Harness = {
  label: "sql",
  run: (body) =>
    Effect.runPromise(
      Effect.flatMap(DurableEngineState.make, body).pipe(
        Effect.provide(migratedDatabase)
      ) as Effect.Effect<never>
    )
}

const memoryHarness: Harness = {
  label: "memory",
  run: (body) => Effect.runPromise(body(DurableEngineState.makeMemory()) as Effect.Effect<never>)
}

const describeContract = (harness: Harness) => {
  describe(`run parent edges (${harness.label})`, () => {
    it("records each distinct edge once with a monotonic store-global sequence", async () => {
      const result = await harness.run((state) =>
        Effect.gen(function*() {
          const first = yield* state.recordRunParent("child", "parent-a")
          const second = yield* state.recordRunParent("child", "parent-b")
          const other = yield* state.recordRunParent("other-child", "parent-a")
          return { first, second, other, listed: yield* state.runParents("child") }
        })
      )

      expect(result.first._tag).toBe("Recorded")
      expect(result.second._tag).toBe("Recorded")
      expect(result.first.edge.seq).toBeLessThan(result.second.edge.seq)
      // The sequence is store-global, not per child.
      expect(result.other.edge.seq).toBeGreaterThan(result.second.edge.seq)
      expect(result.listed.map((edge) => edge.parentId)).toEqual(["parent-a", "parent-b"])
      expect(result.listed.map((edge) => edge.childId)).toEqual(["child", "child"])
    })

    it("keeps the first writer's sequence when the same edge is recorded again", async () => {
      const result = await harness.run((state) =>
        Effect.gen(function*() {
          const first = yield* state.recordRunParent("child", "parent")
          const again = yield* state.recordRunParent("child", "parent")
          return { first, again, listed: yield* state.runParents("child") }
        })
      )

      expect(result.first._tag).toBe("Recorded")
      expect(result.again._tag).toBe("Existing")
      expect(result.again.edge).toEqual(result.first.edge)
      expect(result.listed).toHaveLength(1)
    })

    it("withdraws only the named edge and tolerates withdrawing what is not there", async () => {
      const result = await harness.run((state) =>
        Effect.gen(function*() {
          yield* state.recordRunParent("child", "parent-a")
          yield* state.recordRunParent("child", "parent-b")
          yield* state.removeRunParent("child", "parent-a")
          const afterOne = yield* state.runParents("child")
          // Withdrawing an edge that was never recorded, and one for a child
          // with no edges at all, are both no-ops.
          yield* state.removeRunParent("child", "parent-a")
          yield* state.removeRunParent("unknown-child", "parent-a")
          yield* state.removeRunParent("child", "parent-b")
          return {
            afterOne,
            afterAll: yield* state.runParents("child"),
            unknown: yield* state.runParents("unknown-child")
          }
        })
      )

      expect(result.afterOne.map((edge) => edge.parentId)).toEqual(["parent-b"])
      expect(result.afterAll).toEqual([])
      expect(result.unknown).toEqual([])
    })

    it("re-records a withdrawn edge behind every edge recorded since", async () => {
      const result = await harness.run((state) =>
        Effect.gen(function*() {
          const original = yield* state.recordRunParent("child", "parent")
          yield* state.removeRunParent("child", "parent")
          const later = yield* state.recordRunParent("child", "other-parent")
          const readded = yield* state.recordRunParent("child", "parent")
          return { original, later, readded, listed: yield* state.runParents("child") }
        })
      )

      expect(result.readded._tag).toBe("Recorded")
      // A withdrawal never rewinds the sequence: the re-added edge sorts last.
      expect(result.readded.edge.seq).toBeGreaterThan(result.later.edge.seq)
      expect(result.listed.map((edge) => edge.parentId)).toEqual(["other-parent", "parent"])
    })
  })
}

describeContract(sqlHarness)
describeContract(memoryHarness)

describe("run parent edges (sql fault injection)", () => {
  it("dies rather than inventing an edge when the conflicting row cannot be re-read", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const database = yield* Database.Database
        const first = yield* DurableEngineState.make
        yield* first.recordRunParent("child", "parent")

        // Torn transaction: the INSERT conflicts (the edge exists) but the
        // read-back inside the same write returns nothing.
        const blindSelect = Object.assign(
          (strings: TemplateStringsArray, ...args: ReadonlyArray<unknown>) =>
            strings.join("").includes("FROM flows_run_parents\n      WHERE child_id")
              ? Effect.succeed([])
              : (database.sql as unknown as (
                strings: TemplateStringsArray,
                ...args: ReadonlyArray<unknown>
              ) => unknown)(strings, ...args),
          database.sql
        )
        const torn = yield* DurableEngineState.make.pipe(
          Effect.provideService(
            Database.Database,
            Database.Database.of({ ...database, sql: blindSelect as never })
          )
        )
        return yield* Effect.exit(torn.recordRunParent("child", "parent"))
      }).pipe(Effect.provide(migratedDatabase))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect((defect as Error).message).toBe(
      "run parent edge disappeared during first-writer transaction"
    )
  })
})
