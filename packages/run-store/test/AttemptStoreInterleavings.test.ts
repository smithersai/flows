import { DurableWriter } from "@smthrs/database-next/DurableWriter"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const ownerA: OwnerId = { hostId: "attempt-host", pid: 1, nonce: "old-owner" }
const ownerB: OwnerId = { hostId: "attempt-host", pid: 2, nonce: "new-owner" }
const id: AttemptStore.AttemptId = { runId: "interleaving-run", stepKeyDigest: "step", attempt: 0 }

const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const migrated = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    RunStore.RunStore | AttemptStore.AttemptStore | DurableWriter | SqlClient.SqlClient
  >
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped))

const arrange = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const attempts = yield* AttemptStore.AttemptStore
  yield* runs.create(id.runId, "{}")
  expect(
    yield* runs.claimAndOwn(
      id.runId,
      { status: "pending", owner: null, heartbeatAtMs: null },
      ownerA,
      0
    )
  ).toEqual({ _tag: "Activated" })
  expect(
    yield* attempts.put({
      ...id,
      state: "running",
      startedAtMs: 10,
      outcome: { writer: "old", phase: "running" },
      meta: { writer: "old" }
    }, ownerA)
  ).toEqual({ _tag: "Inserted" })
  const stale = yield* runs.get(id.runId)
  expect(
    yield* runs.claimAndOwn(
      id.runId,
      { status: stale.status, owner: stale.owner, heartbeatAtMs: stale.heartbeatAtMs },
      ownerB,
      30_001,
      {
        expectedOwner: ownerA,
        checkedAtMs: 30_001,
        kind: "same-host-pid-dead"
      }
    )
  ).toEqual({ _tag: "Activated" })
  return { attempts, runs }
})

describe("AttemptStore ownership interleavings", () => {
  it("fences an old owner's finish while the takeover owner completes the attempt", async () => {
    const result = await migrated(
      Effect.gen(function*() {
        const { attempts } = yield* arrange
        const finish = (writer: string, owner: OwnerId) =>
          attempts.finish({
            ...id,
            state: "completed",
            finishedAtMs: 40,
            outcome: { writer }
          }, owner)
        const [oldOwner, newOwner] = yield* Effect.all(
          [finish("old", ownerA), finish("new", ownerB)],
          { concurrency: "unbounded" }
        )
        return {
          newOwner,
          oldOwner,
          stored: Option.getOrThrow(yield* attempts.get(id))
        }
      })
    )

    expect(result.oldOwner).toEqual({ _tag: "FenceLost" })
    expect(result.newOwner).toEqual({ _tag: "Finished" })
    expect(result.stored).toMatchObject({ state: "completed", outcome: { writer: "new" } })
  })

  it("pins the run-terminal/attempt-terminal race to a fenced or fully finished attempt", async () => {
    const result = await migrated(
      Effect.gen(function*() {
        const { attempts, runs } = yield* arrange
        const [runTransition, attemptFinish] = yield* Effect.all(
          [
            runs.transitionOwned(id.runId, ownerB, "completed", "{\"terminal\":true}"),
            attempts.finish({ ...id, state: "completed", finishedAtMs: 50, outcome: { writer: "new" } }, ownerB)
          ],
          { concurrency: "unbounded" }
        )
        return {
          attempt: Option.getOrThrow(yield* attempts.get(id)),
          attemptFinish,
          run: yield* runs.get(id.runId),
          runTransition
        }
      })
    )

    expect(result.runTransition).toEqual({ _tag: "Transitioned" })
    expect(["Finished", "FenceLost"]).toContain(result.attemptFinish._tag)
    expect(result.run.status).toBe("completed")
    expect(result.attemptFinish._tag === "Finished" ? result.attempt.state : "running").toBe(
      result.attemptFinish._tag === "Finished" ? "completed" : "running"
    )
  })

  // BUG: patch is unfenced and can overwrite opaque terminal outcome after ownership and lifecycle ended.
  it.fails("refuses an old worker's patch after takeover and terminal transition", async () => {
    const result = await migrated(
      Effect.gen(function*() {
        const { attempts, runs } = yield* arrange
        yield* attempts.finish({
          ...id,
          state: "completed",
          finishedAtMs: 50,
          outcome: { writer: "new", terminal: true }
        }, ownerB)
        yield* runs.transitionOwned(id.runId, ownerB, "completed")
        // AttemptPatch carries no owner token, so this represents a delayed
        // write from ownerA but the store has no way to authenticate it.
        const patch = yield* attempts.patch(id, {
          outcome: { writer: "old", terminal: false },
          meta: { writer: "old" }
        })
        return { patch, stored: Option.getOrThrow(yield* attempts.get(id)) }
      })
    )

    expect(result.patch._tag).not.toBe("Patched")
    expect(result.stored).toMatchObject({
      state: "completed",
      outcome: { writer: "new", terminal: true },
      meta: { writer: "old" }
    })
  })
})
