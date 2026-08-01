/**
 * Issue #109: the terminal lifecycle records — `attemptFinished`,
 * `hardViolation`, `expectedSetDeviation` — were journalled only *after* the
 * attempt row's terminal transition committed, with the plain `source(deps)`
 * identity, and the replay branches never re-emitted them. A crash in the
 * finish→emit window therefore left the journal permanently missing the
 * attempt's terminal event: `attemptStarted` with no `attemptFinished`,
 * forever, the journal diverged from the attempt table. (Temporal writes
 * history events and mutable state in one transaction.)
 *
 * The terminal records now carry the same per-attempt producer identity
 * issue #91 gave `attemptStarted` — `(sourceId, sourceSeq 0)` — so the
 * replay branches re-emit them idempotently: after a crash the re-drive
 * fills the hole, and on an ordinary replay the journal collapses the
 * re-emission into a `Duplicate`.
 */
import { Journal, type JournalEvent, type Ownership, RunStore } from "@smithers/journal"
import * as TestJournal from "@smithers/journal/test/TestJournal"
import { Jj } from "@smithers/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as ActivityPersistence from "../src/internal/ActivityPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const owner: Ownership.OwnerId = { hostId: "terminal-emit-host", pid: 61, nonce: "terminal-emit-process" }

const declared: ActivityPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "terminal-emit-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (
  runId: string,
  key: string,
  execute: () => Effect.Effect<unknown, unknown>,
  options: { readonly tier?: ActivityPersistence.Tier; readonly metadata?: ActivityPersistence.BoundaryMetadata } =
    {}
) =>
  ActivityPersistence.make({ runId, owner, sourceId: `terminal-emit-${runId}`, execute })({
    activity: {},
    attempt: 1,
    key,
    tier: options.tier ?? "sealed",
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  })

/**
 * A journal that crashes the process (dies) the first time the given event
 * type is emitted — after the attempt row's terminal transition committed,
 * before the journal saw the record: the exact SIGKILL window.
 */
const crashOnce = (journal: Journal.Journal["Service"], eventType: string): Journal.Journal["Service"] => {
  let crashed = false
  return {
    ...journal,
    emitDurable: (input: JournalEvent.Input, journalOwner?: Ownership.OwnerId) =>
      Effect.gen(function*() {
        if (!crashed && input.eventType === eventType) {
          crashed = true
          return yield* Effect.die(new Error(`simulated crash before ${eventType}`))
        }
        return yield* journal.emitDurable(input, journalOwner)
      })
  }
}

const eventsOf = (runId: string, eventType: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 100 })
    return page.entries.filter((entry) => entry.eventType === eventType)
  })

const boundary = StepBoundary.layerTest({ readSnapshot: declared.readSet })

describe("replay re-emission tolerates a foreign-lineage terminal record (issue #109)", () => {
  it("continues when the journal already holds the record under another lineage's payload", async () => {
    // A time-travel fork copies the parent's journal rows: the copied
    // terminal record carries the same producer identity but names the
    // parent run in its payload, so the re-emission raises
    // idempotency_conflict rather than collapsing to a Duplicate. The
    // terminal event exists — only its absence is the defect — so the
    // replay must proceed.
    const runId = "terminal-foreign-lineage"
    const key = "terminal-emit/foreign"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate(runId)
        const crashed = yield* dispatch(runId, key, () => Effect.succeed("done"), { metadata: declared }).pipe(
          Effect.provideService(Journal.Journal, crashOnce(journal, "flows.engine.attempt-finished")),
          Effect.provide(boundary),
          Effect.exit
        )
        // The copied record: same producer identity, foreign payload.
        const { Digest } = yield* Effect.promise(() => import("@smithers/keys"))
        yield* journal.emitDurable({
          runId: runId as never,
          sourceId: `terminal-emit-${runId}:attempt:${Digest.digest(key)}:1:finished` as never,
          sourceSeq: 0 as never,
          eventType: "flows.engine.attempt-finished",
          payload: { runId: "the-fork-parent", state: "succeeded" }
        } as never, owner)
        const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
          metadata: declared
        }).pipe(Effect.provide(boundary))
        return { crashed, replayed }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.crashed._tag).toBe("Failure")
    expect(outcome.replayed).toBe("done")
  })

  it("still surfaces journal failures that are not idempotency conflicts", async () => {
    const runId = "terminal-journal-broken"
    const key = "terminal-emit/broken"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate(runId)
        const crashed = yield* dispatch(runId, key, () => Effect.succeed("done"), { metadata: declared }).pipe(
          Effect.provideService(Journal.Journal, crashOnce(journal, "flows.engine.attempt-finished")),
          Effect.provide(boundary),
          Effect.exit
        )
        // The re-drive's journal is genuinely broken: the convergence emit
        // must not swallow that.
        const broken: typeof journal = {
          ...journal,
          emitDurable: (input, journalOwner) =>
            input.eventType === "flows.engine.attempt-finished"
              ? Effect.fail(
                new Journal.JournalError({ code: "queue_overflow", message: "journal saturated" })
              )
              : journal.emitDurable(input, journalOwner)
        }
        const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
          metadata: declared
        }).pipe(
          Effect.provideService(Journal.Journal, broken),
          Effect.provide(boundary),
          Effect.exit
        )
        return { crashed, replayed }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.crashed._tag).toBe("Failure")
    expect(outcome.replayed._tag).toBe("Failure")
  })
})

describe("terminal lifecycle emits survive the finish→emit crash window (issue #109)", () => {
  it("re-emits attemptFinished on the succeeded replay branch after a crash", async () => {
    const runId = "terminal-crash-succeeded"
    const key = "terminal-emit/succeeded"
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate(runId)
        // First drive dies between attempts.finish and the terminal emit.
        const crashed = yield* dispatch(runId, key, () => Effect.succeed("done"), { metadata: declared }).pipe(
          Effect.provideService(Journal.Journal, crashOnce(journal, "flows.engine.attempt-finished")),
          Effect.provide(boundary),
          Effect.exit
        )
        const missing = yield* eventsOf(runId, "flows.engine.attempt-finished")
        // Re-drive: the succeeded attempt row replays — and must fill the
        // journal hole.
        const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
          metadata: declared
        }).pipe(Effect.provide(boundary))
        const events = yield* eventsOf(runId, "flows.engine.attempt-finished")
        // A second ordinary replay collapses to a Duplicate, not a new row.
        yield* dispatch(runId, key, () => Effect.die("must not re-execute"), { metadata: declared }).pipe(
          Effect.provide(boundary)
        )
        const after = yield* eventsOf(runId, "flows.engine.attempt-finished")
        return { crashed, missing, replayed, events, after }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.crashed._tag).toBe("Failure")
    expect(outcome.missing).toHaveLength(0)
    expect(outcome.replayed).toBe("done")
    expect(outcome.events).toHaveLength(1)
    expect((outcome.events[0]!.payload as { state?: string }).state).toBe("succeeded")
    expect(outcome.after).toHaveLength(1)
  })

  it("re-emits hardViolation and attemptFinished on the failed replay branch", async () => {
    const runId = "terminal-crash-violation"
    const key = "terminal-emit/violation"
    const violating = StepBoundary.layerTest({ changedPaths: ["config.json"], readSnapshot: declared.readSet })
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate(runId)
        // The settle fails hard; the crash lands before hardViolation.
        const crashed = yield* dispatch(runId, key, () => Effect.succeed("wrote outside"), {
          metadata: declared
        }).pipe(
          Effect.provideService(Journal.Journal, crashOnce(journal, "flows.engine.hard-violation")),
          Effect.provide(violating),
          Effect.exit
        )
        const missing = yield* eventsOf(runId, "flows.engine.hard-violation")
        // Re-drive replays the durably failed attempt by rethrowing — and
        // must fill both journal holes first.
        const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
          metadata: declared
        }).pipe(Effect.provide(violating), Effect.exit)
        const violations = yield* eventsOf(runId, "flows.engine.hard-violation")
        const finished = yield* eventsOf(runId, "flows.engine.attempt-finished")
        return { crashed, missing, replayed, violations, finished }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.crashed._tag).toBe("Failure")
    expect(outcome.missing).toHaveLength(0)
    expect(outcome.replayed._tag).toBe("Failure")
    expect(outcome.violations).toHaveLength(1)
    expect(outcome.finished).toHaveLength(1)
    expect((outcome.finished[0]!.payload as { state?: string }).state).toBe("failed")
  })

  it("re-emits expectedSetDeviation alongside the finish on succeeded replays", async () => {
    const runId = "terminal-crash-deviation"
    const key = "terminal-emit/deviation"
    const deviating = StepBoundary.layerTest({
      changedPaths: ["config.json"],
      readSnapshot: declared.readSet
    })
    const expectedMode = { ...declared, boundaryMode: "expected" as const }
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* activate(runId)
        const crashed = yield* dispatch(runId, key, () => Effect.succeed("deviated"), {
          metadata: expectedMode
        }).pipe(
          Effect.provideService(Journal.Journal, crashOnce(journal, "flows.engine.expected-set-deviation")),
          Effect.provide(deviating),
          Effect.exit
        )
        const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
          metadata: expectedMode
        }).pipe(Effect.provide(deviating))
        const deviations = yield* eventsOf(runId, "flows.engine.expected-set-deviation")
        const finished = yield* eventsOf(runId, "flows.engine.attempt-finished")
        return { crashed, replayed, deviations, finished }
      }).pipe(Effect.provide(Layer.mergeAll(TestJournal.layer(), jjLayer)), Effect.scoped)
    )
    expect(outcome.crashed._tag).toBe("Failure")
    expect(outcome.replayed).toBe("deviated")
    expect(outcome.deviations).toHaveLength(1)
    expect(outcome.finished).toHaveLength(1)
  })
})
