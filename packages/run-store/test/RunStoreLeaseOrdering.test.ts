import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database-next"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import { Effect, Exit } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "lease-host", pid: 17, nonce: "lease-owner" }

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>
) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

const activate = (store: RunStoreLive.Service, runId: string) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    expect(
      yield* store.claimAndOwn(
        runId,
        { status: "pending", owner: null, heartbeatAtMs: null },
        owner,
        100
      )
    ).toEqual({ _tag: "Activated" })
  })

describe("RunStore heartbeat timestamp ordering", () => {
  // BUG: a fenced heartbeat overwrites heartbeat_at_ms even when its caller timestamp is older.
  it.effect.fails("keeps the lease timestamp monotonic when an older heartbeat arrives late", () =>
    Effect.gen(function*() {
      const row = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-monotonic")
          expect(yield* store.heartbeat("lease-monotonic", owner, 200)).toEqual({ _tag: "Updated" })
          expect(yield* store.heartbeat("lease-monotonic", owner, 150)).toEqual({ _tag: "Updated" })
          return yield* store.get("lease-monotonic")
        })
      )

      expect(row.heartbeatAtMs).toBe(200)
    }))

  it.effect("accepts a safe-integer timestamp arbitrarily far in the future", () =>
    Effect.gen(function*() {
      const future = 8_000_000_000_000
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-future")
          const outcome = yield* store.heartbeat("lease-future", owner, future)
          return { outcome, row: yield* store.get("lease-future") }
        })
      )

      // CONTRACT: RunStore applies no wall-clock plausibility window.
      expect(result.outcome).toEqual({ _tag: "Updated" })
      expect(result.row.heartbeatAtMs).toBe(future)
    }))

  it.effect("lets SQLite reject negative, fractional, and NaN heartbeat timestamps", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-invalid")
          const exits = yield* Effect.forEach(
            [-1, 1.5, Number.NaN],
            (timestamp) => Effect.exit(store.heartbeat("lease-invalid", owner, timestamp))
          )
          return { exits, row: yield* store.get("lease-invalid") }
        })
      )

      // CONTRACT: heartbeat has no explicit timestamp validator; invalid values
      // fail through persistence rather than RunStore's invalid_run vocabulary.
      expect(result.exits.every((exit) => Exit.isFailure(exit))).toBe(true)
      expect(
        result.exits.map((exit) =>
          Exit.isFailure(exit)
            ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
            : undefined
        )
      ).toEqual([
        expect.objectContaining({ code: "constraint", method: "heartbeat" }),
        expect.objectContaining({ code: "constraint", method: "heartbeat" }),
        expect.objectContaining({ method: "heartbeat" })
      ])
      expect(result.row.heartbeatAtMs).toBe(100)
    }))
})
