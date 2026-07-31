import { Flow, FlowEngine } from "@smithers/engine"
import { Journal, Ownership, RunStore, TestJournal } from "@smithers/journal"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"

const TestFlow = Flow.make("Ownership/Test", {
  payload: {},
  success: Schema.String
})

const ownerA: Ownership.OwnerId = {
  hostId: "host-a",
  pid: 1,
  nonce: "owner-a"
}

const ownerB: Ownership.OwnerId = {
  hostId: "host-b",
  pid: 2,
  nonce: "owner-b"
}

const fakeEngine = {} as unknown as FlowEngine.FlowEngine["Service"]

const persistedState = JSON.stringify({
  version: 1,
  flowName: TestFlow._tag,
  payload: {}
})

const makeDriver = (
  owner: Ownership.OwnerId,
  isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean> = () => Effect.succeed(true)
) =>
  RunDriver.make({
    owner,
    journalSource: `ownership-${owner.nonce}`,
    isAlive,
    engine: Effect.succeed(fakeEngine)
  })

const activate = (
  store: RunStore.Service,
  runId: string,
  owner: Ownership.OwnerId
) =>
  Effect.gen(function*() {
    yield* store.create(runId, persistedState)
    const row = yield* store.get(runId)
    const expected = {
      status: row.status,
      owner: row.owner,
      heartbeatAtMs: row.heartbeatAtMs
    }
    const claim = yield* store.claim(runId, expected, owner, 0)
    expect(claim).toEqual({
      _tag: "Claimed",
      claimedAtMs: 0
    })
    if (claim._tag !== "Claimed") return
    expect(yield* store.activate(runId, owner, claim.claimedAtMs, expected)).toEqual({
      _tag: "Activated"
    })
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.provide(TestJournal.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  ) as Effect.Effect<A, E, Exclude<R, Journal.Journal | RunStore.RunStore | Scope.Scope>>

describe("RunDriver ownership", () => {
  it("allows one concurrent claimant to drive an execution", async () => {
    let executions = 0
    const row = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const first = yield* makeDriver(ownerA)
      const second = yield* makeDriver(ownerB)
      const handler = () =>
        Effect.sync(() => {
          executions++
          return "done"
        })
      yield* first.register(TestFlow, handler)
      yield* second.register(TestFlow, handler)

      yield* Effect.all([
        first.execute(TestFlow, {
          executionId: "concurrent",
          payload: {},
          discard: true
        }),
        second.execute(TestFlow, {
          executionId: "concurrent",
          payload: {},
          discard: true
        })
      ], { concurrency: "unbounded" })
      return yield* (yield* RunStore.RunStore).get("concurrent")
    })))

    expect(executions).toBe(1)
    expect(row.status).toBe("completed")
  })

  it("refuses to steal from a fresh owner without probing liveness", async () => {
    let probes = 0
    const row = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* activate(store, "fresh", ownerA)
      const driver = yield* makeDriver(ownerB, () =>
        Effect.sync(() => {
          probes++
          return false
        }))
      yield* driver.register(TestFlow, () => Effect.succeed("wrong"))
      yield* driver.resume(TestFlow, "fresh")
      return yield* store.get("fresh")
    })))

    expect(probes).toBe(0)
    expect(row.status).toBe("running")
    expect(row.owner).toEqual(ownerA)
  })

  it("steals a stale owner only after the liveness probe supplies evidence", async () => {
    let probes = 0
    const row = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* activate(store, "stale", ownerA)
      yield* TestClock.adjust("31 seconds")

      const driver = yield* makeDriver(ownerB, (owner) =>
        Effect.sync(() => {
          probes++
          expect(owner).toEqual(ownerA)
          return false
        }))
      yield* driver.register(TestFlow, () => Effect.succeed("recovered"))
      yield* driver.resume(TestFlow, "stale")
      return yield* store.get("stale")
    })))

    expect(probes).toBe(1)
    expect(row.status).toBe("completed")
    expect(row.owner).toBeNull()
    expect(row.heartbeatAtMs).toBeNull()
  })

  it("abandons an activation race without starting a handler", async () => {
    let executions = 0
    const result = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const base = yield* RunStore.RunStore
      yield* activate(base, "activation-race", ownerA)
      yield* TestClock.adjust("31 seconds")

      let abandoned = 0
      const racing = RunStore.makeNoop({
        ...base,
        activate: (runId, claimant, claimedAtMs, expected) =>
          base.heartbeat(runId, ownerA, 31_000).pipe(
            Effect.andThen(
              base.activate(runId, claimant, claimedAtMs, expected)
            )
          ),
        abandonClaim: (runId, claimant, claimedAtMs) =>
          base.abandonClaim(runId, claimant, claimedAtMs).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                abandoned++
              })
            )
          )
      })
      const driver = yield* makeDriver(ownerB, () => Effect.succeed(false)).pipe(
        Effect.provideService(RunStore.RunStore, racing)
      )
      yield* driver.register(TestFlow, () =>
        Effect.sync(() => {
          executions++
          return "wrong"
        }))
      yield* driver.resume(TestFlow, "activation-race")
      return {
        abandoned,
        row: yield* base.get("activation-race")
      }
    })))

    expect(executions).toBe(0)
    expect(result.abandoned).toBe(1)
    expect(result.row.owner).toEqual(ownerA)
    expect(result.row.claim).toBeNull()
  })

  it("suspension atomically clears owner and heartbeat", async () => {
    const row = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver(ownerA)
      yield* driver.register(TestFlow, () =>
        Effect.flatMap(
          FlowEngine.FlowInstance,
          Flow.suspend
        ))
      yield* driver.execute(TestFlow, {
        executionId: "suspended",
        payload: {},
        discard: true
      })
      return yield* (yield* RunStore.RunStore).get("suspended")
    })))

    expect(row.status).toBe("suspended")
    expect(row.owner).toBeNull()
    expect(row.heartbeatAtMs).toBeNull()
  })

  it("interrupts the driver when its heartbeat fence is lost", async () => {
    const result = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const driver = yield* makeDriver(ownerA)
      const started = yield* Deferred.make<void>()
      let interrupted = false
      yield* driver.register(TestFlow, () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              interrupted = true
            })
          )
        ))

      const fiber = yield* driver.execute(TestFlow, {
        executionId: "fence-loss",
        payload: {},
        discard: true
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      expect(
        yield* store.transitionOwned("fence-loss", ownerA, "suspended")
      ).toEqual({ _tag: "Transitioned" })
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Effect.yieldNow
      const exit = yield* Fiber.await(fiber)
      return {
        interrupted,
        exit,
        row: yield* store.get("fence-loss")
      }
    })))

    expect(result.interrupted).toBe(true)
    expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
    expect(result.row.status).toBe("suspended")
    expect(result.row.owner).toBeNull()
  })
})
