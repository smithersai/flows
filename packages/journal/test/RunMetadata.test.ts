import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "host", pid: 1, nonce: "n" }

const layer = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, RunStore.RunStore | DurableWriter | SqlClient.SqlClient>
) => it(name, () => Effect.runPromise(body().pipe(Effect.provide(layer), Effect.scoped)))

const own = (store: RunStore.Service, runId: string) =>
  store.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)

describe("run metadata", () => {
  effect("create records lineage and exposes it on the row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("parent", "{}")
      yield* store.create("child", "{}", { parentRunId: "parent" })
      const parent = yield* store.get("parent")
      const child = yield* store.get("child")
      expect(parent.parentRunId).toBeNull()
      expect(parent.cancelRequestedAtMs).toBeNull()
      expect(child.parentRunId).toBe("parent")
    }))

  effect("lineage is walkable in SQL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("a", "{}")
      yield* store.create("b", "{}", { parentRunId: "a" })
      yield* store.create("c", "{}", { parentRunId: "b" })
      const rows = yield* sql<{ readonly run_id: string }>`
        WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
          SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = 'c'
          UNION ALL
          SELECT flows_runs.run_id, flows_runs.parent_run_id
          FROM flows_runs JOIN ancestry ON flows_runs.run_id = ancestry.parent_run_id
        )
        SELECT run_id FROM ancestry
      `
      expect(rows.map((row) => row.run_id)).toEqual(["c", "b", "a"])
    }))

  effect("requestCancel is idempotent and unfenced", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("missing", 900)).toEqual({ _tag: "NotFound" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBe(500)
    }))

  effect("a guarded completion loses to a cancel request", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      yield* store.requestCancel("run", 500)
      const guarded = yield* store.transitionOwned("run", owner, "completed", undefined, {
        cancelRequested: "absent"
      })
      expect(guarded).toEqual({ _tag: "GuardFailed" })
      expect((yield* store.get("run")).status).toBe("running")
    }))

  effect("a guarded completion wins when no cancel was requested", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      const guarded = yield* store.transitionOwned("run", owner, "completed", undefined, {
        cancelRequested: "absent"
      })
      expect(guarded).toEqual({ _tag: "Transitioned" })
    }))

  effect("a cancel-present guard admits only a requested cancellation", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(
        yield* store.transitionOwned("run", owner, "cancelled", undefined, { cancelRequested: "present" })
      ).toEqual({ _tag: "GuardFailed" })
      yield* store.requestCancel("run", 500)
      expect(
        yield* store.transitionOwned("run", owner, "cancelled", undefined, { cancelRequested: "present" })
      ).toEqual({ _tag: "Transitioned" })
    }))

  effect("a guard on a lost fence still reports the fence loss", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      const other: OwnerId = { hostId: "host", pid: 2, nonce: "other" }
      expect(
        yield* store.transitionOwned("run", other, "completed", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "FenceLost" })
      expect(
        yield* store.transitionOwned("missing", owner, "completed", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "NotFound" })
    }))

  effect("a guarded running transition keeps ownership", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(
        yield* store.transitionOwned("run", owner, "running", `{"a":1}`, { cancelRequested: "absent" })
      ).toEqual({ _tag: "Transitioned" })
      yield* store.requestCancel("run", 500)
      expect(
        yield* store.transitionOwned("run", owner, "running", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "GuardFailed" })
    }))

  effect("create rejects an empty parent run id", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const failure = yield* Effect.flip(store.create("run", "{}", { parentRunId: "" }))
      expect(failure.code).toBe("invalid_run")
    }))

  effect("requestCancel rejects an invalid timestamp", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const failure = yield* Effect.flip(store.requestCancel("run", -1))
      expect(failure.code).toBe("invalid_run")
    }))

  effect("the noop store reports typed losses for the new operations", () =>
    Effect.gen(function*() {
      const store = RunStore.makeNoop()
      expect(yield* store.requestCancel("run", 1)).toEqual({ _tag: "NotFound" })
    }))
})
