import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as RunStore from "../src/RunStore.ts"

const owner = { hostId: "host", pid: 1, nonce: "nonce" }
const expected: RunStore.RunSnapshot = {
  status: "pending",
  owner: null,
  heartbeatAtMs: null
}

describe("service contracts", () => {
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

  it("constructs and exercises the RunStore stub", async () => {
    const service = RunStore.makeNoop()
    expect((await Effect.runPromise(Effect.flip(service.create("run", "{}")))).method).toBe("create")
    expect((await Effect.runPromise(Effect.flip(service.get("run")))).method).toBe("get")
    expect(await Effect.runPromise(service.claim("run", expected, owner, 0))).toEqual({ _tag: "NotFound" })
    expect(await Effect.runPromise(service.claimAndOwn("run", expected, owner, 0))).toEqual({ _tag: "NotFound" })
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
