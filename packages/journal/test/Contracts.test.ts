import { Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as CacheStore from "../src/CacheStore.ts"
import * as Journal from "../src/Journal.ts"
import type { Input, RunId } from "../src/JournalEvent.ts"
import * as Projection from "../src/Projection.ts"
import * as RunStore from "../src/RunStore.ts"

const owner = { hostId: "host", pid: 1, nonce: "nonce" }
const expected: RunStore.RunSnapshot = {
  status: "pending",
  owner: null,
  heartbeatAtMs: null
}

describe("service contracts", () => {
  it("constructs and exercises the closed Journal service", async () => {
    const implementation = Journal.makeNoop()
    expect(Journal.make(implementation)).toBe(implementation)

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const input = {} as Input
      expect((yield* Effect.flip(implementation.emit(input))).code).toBe("journal_closed")
      expect(
        (yield* Effect.flip(implementation.entries({
          runId: "run" as RunId,
          limit: 1
        }))).code
      ).toBe("journal_closed")
      expect(
        (yield* Stream.runHead(implementation.stream({
          runId: "run" as RunId
        })).pipe(Effect.flip)).code
      ).toBe("journal_closed")
      expect(
        (yield* Stream.runHead(implementation.project(
          Projection.make({
            name: "noop",
            initial: 0,
            reduce: (state) => Effect.succeed(state)
          }),
          { runId: "run" as RunId }
        )).pipe(Effect.flip)).code
      ).toBe("journal_closed")
      expect((yield* Effect.flip(implementation.flush)).code).toBe("journal_closed")
      yield* implementation.changes
    })))

    const overridden = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* Journal.Journal
        yield* service.flush
        return service
      }).pipe(Effect.provide(Journal.layerNoop({ flush: Effect.void })))
    )
    expect(overridden.flush).toBe(Effect.void)
  })

  it("constructs and exercises the AttemptStore stub", async () => {
    const service = AttemptStore.makeNoop()
    const attempt: AttemptStore.Attempt = {
      runId: "run",
      stepKeyDigest: "digest",
      attempt: 0,
      state: "running",
      startedAtMs: 0,
      meta: {}
    }
    const finish: AttemptStore.FinishAttempt = {
      runId: "run",
      stepKeyDigest: "digest",
      attempt: 0,
      state: "completed",
      finishedAtMs: 1
    }
    expect((await Effect.runPromise(Effect.flip(service.put(attempt, owner)))).message).toContain("put")
    expect((await Effect.runPromise(Effect.flip(service.get(attempt)))).message).toContain("get")
    expect(
      (await Effect.runPromise(Effect.flip(
        service.heartbeat("run", "digest", 0, owner, 1)
      ))).message
    ).toContain("heartbeat")
    expect((await Effect.runPromise(Effect.flip(service.finish(finish, owner)))).message).toContain("finish")

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* AttemptStore.AttemptStore).get(attempt)
      }).pipe(
        Effect.provide(AttemptStore.layerNoop({
          get: () => Effect.succeed(Option.none())
        }))
      )
    )
    expect(Option.isNone(result)).toBe(true)
  })

  it("constructs and exercises the CacheStore stub", async () => {
    const service = CacheStore.makeNoop()
    const entry: CacheStore.CacheEntry = {
      keyDigest: "digest",
      result: {},
      meta: {},
      createdAtMs: 0,
      recordedRunId: "run",
      recordedEventSeq: 0
    }
    expect((await Effect.runPromise(Effect.flip(service.get("digest")))).message).toContain("get")
    expect((await Effect.runPromise(Effect.flip(service.put(entry)))).message).toContain("put")
    expect((await Effect.runPromise(Effect.flip(service.evict("digest")))).message).toContain("evict")

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* CacheStore.CacheStore).get("digest")
      }).pipe(
        Effect.provide(CacheStore.layerNoop({
          get: () => Effect.succeed(Option.none())
        }))
      )
    )
    expect(Option.isNone(result)).toBe(true)
  })

  it("constructs and exercises the RunStore stub", async () => {
    const service = RunStore.makeNoop()
    expect((await Effect.runPromise(Effect.flip(service.create("run", "{}")))).method).toBe("create")
    expect((await Effect.runPromise(Effect.flip(service.get("run")))).method).toBe("get")
    expect(await Effect.runPromise(service.claim("run", expected, owner, 0))).toEqual({ _tag: "NotFound" })
    expect(await Effect.runPromise(service.activate("run", owner, 0, expected))).toEqual({ _tag: "ClaimLost" })
    expect(await Effect.runPromise(service.abandonClaim("run", owner, 0))).toEqual({ _tag: "ClaimLost" })
    expect(
      await Effect.runPromise(service.recoverClaim("run", owner, 0, owner, 31_000, {
        expectedOwner: owner,
        checkedAtMs: 31_000,
        kind: "same-host-pid-dead"
      }))
    ).toEqual({ _tag: "NotFound" })
    expect(await Effect.runPromise(service.heartbeat("run", owner, 0))).toEqual({ _tag: "NotFound" })
    expect(await Effect.runPromise(service.transitionOwned("run", owner, "failed"))).toEqual({ _tag: "NotFound" })
    expect(
      await Effect.runPromise(service.steal("run", expected, owner, 0, {
        expectedOwner: owner,
        checkedAtMs: 0,
        kind: "same-host-pid-dead"
      }))
    ).toEqual({ _tag: "NotFound" })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* RunStore.RunStore).heartbeat("run", owner, 0)
      }).pipe(
        Effect.provide(RunStore.layerNoop({
          heartbeat: () => Effect.succeed({ _tag: "Updated" })
        }))
      )
    )
    expect(result).toEqual({ _tag: "Updated" })
  })
})
