/**
 * Time travel over a journal an ORDINARY ENGINE RUN wrote.
 *
 * Every other suite in this package hand-authors the evidence it folds. That
 * made the whole feature untested against its only real producer, and it hid
 * the defect this file exists to pin: nothing in the engine populated
 * `meta.lineageId`, so `inspect` failed `not_found` on every production
 * journal, and a fork read the parent's CURRENT state and ALL of its attempts
 * rather than the ones its frame can explain.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as DurableWriter from "@smthrs/database-next/DurableWriter"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store-next/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store-next/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store-next/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store-next/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store-next/StepBoundary"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow-next"
import * as Jj from "@smthrs/jj-next"
import * as Journal from "@smthrs/journal-next/Journal"
import type * as JournalEvent from "@smthrs/journal-next/JournalEvent"
import * as SqlJournal from "@smthrs/journal-next/SqlJournal"
import * as AttemptStore from "@smthrs/run-store-next/AttemptStore"
import * as RunStore from "@smthrs/run-store-next/RunStore"
import * as CacheStore from "@smthrs/step-cache-next/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as CompensationHandlers from "../src/CompensationHandlers.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import type { TimeTravelError } from "../src/TimeTravelError.ts"

/**
 * The declared step the flow's body names.
 *
 * DECIDED (2026-08-11, pending review): the composite handler this suite always
 * had becomes ONE declared action rather than four body nodes. What is under
 * test is time travel over an engine-written journal, so the fixture keeps the
 * action mix and the ordering the evidence assertions are written against;
 * decomposing it would rewrite the evidence rather than migrate the authoring
 * shape. The body still names an action instead of carrying code, which is
 * the migration `docs/specs/Concepts/Unified Flow Authoring.md` asks for.
 */
const Post = Action.make("time-travel/Post", { payload: {}, success: Schema.String })
const Ledger = Flow.make("time-travel/Ledger", {
  payload: {},
  success: Schema.String,
  body: (payload) => Post.call(payload)
})
const Settled = DurableDeferred.make("time-travel/settled", { success: Schema.String })

/** The irreversible action whose boundary records a rewind has to assess. */
const notifyKind = "time-travel/Notify"

/**
 * Records every jj call so the tests can assert the workspace a fork lands in
 * is restored to the FRAME's pointer, not left at the parent's tree.
 */
const recordingJj = (calls: Array<string>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: (message) =>
        Effect.sync(() => {
          calls.push(`snapshot:${message}`)
          return { changeId: `change-${calls.length}` as never }
        }),
      restore: (changeId) => Effect.sync(() => void calls.push(`restore:${changeId}`)),
      diff: () => Effect.succeed(""),
      workspaceAdd: (name) => Effect.sync(() => void calls.push(`add:${name}`)),
      workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`)),
      status: () => Effect.succeed("")
    })
  )

interface Harness {
  readonly notifications: Array<string>
  readonly jjCalls: Array<string>
}

/**
 * The production composition, over an in-memory database.
 *
 * `EngineStore.layer` is the real one — the same wiring an application uses —
 * which is the whole point: the lineage metadata under test has to be minted by
 * the engine itself, not by the test.
 */
const engineLayer = (harness: Harness, handlers: ReadonlyArray<CompensationHandlers.Handler>) => {
  const Credit = Action.make({
    name: "time-travel/Credit",
    success: Schema.Number,
    tier: "sealed",
    idempotencyKey: "time-travel/credit/v1",
    execute: Effect.succeed(30)
  })
  const Notify = Action.make({
    name: notifyKind,
    success: Schema.String,
    tier: "irreversible",
    idempotencyKey: "time-travel/notify/v1",
    execute: Effect.sync(() => {
      harness.notifications.push("sent")
      return "sent"
    })
  })
  // A compensable action is what OWNS a workspace pointer: the engine
  // snapshots the tree before it runs. Every later frame carries that pointer
  // forward, which is what gives a sealed action's frame a tier-2 address at
  // all.
  const Stage = Action.make({
    name: "time-travel/Stage",
    success: Schema.String,
    tier: "compensable",
    idempotencyKey: "time-travel/stage/v1",
    execute: Effect.succeed("staged")
  })
  const post = () =>
    Effect.gen(function*() {
      yield* Stage
      const amount = yield* Credit
      const receipt = yield* Notify
      const settled = yield* DurableDeferred.await(Settled)
      return `${amount}:${receipt}:${settled}`
    })

  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)))

  return Layer.mergeAll(Post.toLayer(post), Interpreter.layer(Ledger)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TimeTravel.layer),
    Layer.provideMerge(CompensationHandlers.layer(handlers)),
    Layer.provideMerge(SqlTimeTravelStore.layer),
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: "time-travel-test" },
        journalSource: "time-travel-test",
        isAlive: () => Effect.succeed(false)
      })
    ),
    Layer.provideMerge(
      // NodeCrypto feeds the merged stack rather than sitting beside it:
      // OwnerIdentity.layer consumes the Crypto service at construction.
      Layer.mergeAll(
        stores,
        StepBoundary.layerTest(),
        recordingJj(harness.jjCalls),
        OwnerIdentity.layer
      ).pipe(Layer.provideMerge(NodeCrypto.layer))
    ),
    Layer.provideMerge(TestDatabase.layer)
  )
}

const drive = <A, E>(
  handlers: ReadonlyArray<CompensationHandlers.Handler>,
  body: (harness: Harness) => Effect.Effect<
    A,
    E,
    DurableWriter.DurableWriter | Journal.Journal | RunStore.RunStore | SqlClient.SqlClient | TimeTravel
  >
): Promise<A> => {
  const harness: Harness = { notifications: [], jjCalls: [] }
  return Effect.runPromise(
    Effect.gen(function*() {
      // Park the run at the deferred. It releases ownership on the way out,
      // which is the only state a rewind accepts.
      yield* Ledger.execute({}, { executionId: "ledger-1", discard: true })
      const journal = yield* Journal.Journal
      yield* journal.flush
      return yield* body(harness)
    }).pipe(
      Effect.provide(engineLayer(harness, handlers)),
      Effect.scoped
    ) as Effect.Effect<A, E>
  )
}

const entries = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 200 })
  return page.entries
})

/** The seq of the `nth` (1-based) record of `eventType`, which is where frames land. */
const seqOf = (
  committed: ReadonlyArray<JournalEvent.Entry>,
  eventType: string,
  nth = 1
): number => committed.filter((entry) => entry.eventType === eventType)[nth - 1]!.seq

describe("time travel over an engine-written journal", () => {
  it("folds an ordinary engine journal with no hand-emitted metadata", async () => {
    const result = await drive([], () =>
      Effect.gen(function*() {
        const committed = yield* entries
        const timeTravel = yield* TimeTravel
        const attempts = yield* timeTravel.inspect(
          { runId: "ledger-1", frame: { lineageId: "ledger-1/root", seq: committed.at(-1)!.seq } },
          {
            initial: 0,
            reduce: (state: number, entry) => entry.eventType === "flows.engine.attempt-started" ? state + 1 : state
          }
        )
        return {
          attempts,
          lineages: [...new Set(committed.map((entry) => (entry.meta as { lineageId?: string }).lineageId))],
          anchored: committed.filter((entry) => entry.eventType === "flows.engine.snapshot-identified").length
        }
      }))

    // The engine minted one lineage for the run and stamped it on every record.
    expect(result.lineages).toEqual(["ledger-1/root"])
    // Four dispatches, and the fold saw them: the body's own step, then the
    // three actions its implementation runs before the deferred parks it.
    expect(result.attempts).toBe(4)
    // Every frame carries a tier-2 anchor, not just the compensable one.
    expect(result.anchored).toBe(4)
  })

  it("forks at a frame with the state and attempts of THAT frame, and spares the parent's tree", async () => {
    const result = await drive([], (harness) =>
      Effect.gen(function*() {
        const committed = yield* entries
        // Cut when the compensable and sealed actions had settled and the
        // irreversible one had not yet been admitted.
        const frameSeq = seqOf(committed, "flows.engine.attempt-finished", 2)
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const timeTravel = yield* TimeTravel
        const fork = yield* timeTravel.fork({
          runId: "ledger-1",
          frame: { lineageId: "ledger-1/root", seq: frameSeq }
        })
        const state = yield* sql<{ readonly run_id: string; readonly state_json: string }>`
          SELECT run_id, state_json FROM flows_runs WHERE run_id IN ('ledger-1', ${fork.runId})
        `
        const attempts = yield* sql<{ readonly run_id: string; readonly step_key_digest: string }>`
          SELECT run_id, step_key_digest FROM flows_attempts
          WHERE run_id IN ('ledger-1', ${fork.runId})
        `
        return {
          fork,
          parentState: state.find((row) => row.run_id === "ledger-1")!.state_json,
          childState: state.find((row) => row.run_id === fork.runId)!.state_json,
          parentAttempts: attempts.filter((row) => row.run_id === "ledger-1").length,
          childAttempts: attempts.filter((row) => row.run_id === fork.runId).length,
          jjCalls: [...harness.jjCalls]
        }
      }))

    expect(result.fork.edge).toMatchObject({ parentRunId: "ledger-1", kind: "fork", attached: false })
    // The child's state is the state AT the frame, so it differs from the
    // parent's current state (which the parent kept driving past).
    expect(result.childState).not.toBe(result.parentState)
    // The parent recorded four attempts — the body's step and the three
    // actions under it; the child inherits only the ones its copied prefix
    // can explain.
    expect(result.parentAttempts).toBe(4)
    expect(result.childAttempts).toBe(3)
    // The fork gets its OWN workspace and leaves the parent's tree alone:
    // `Jj.restore` acts on the one working copy the layer is rooted at, so a
    // fork that called it would restore the parent — forbidden by
    // `docs/specs/Concepts/Time Travel.md` §Fork. The pointer it could not pin
    // the lane to is disclosed instead
    // (`.smithers/tickets/fork-workspace-revision.md`).
    expect(result.jjCalls.some((call) => call.startsWith("add:"))).toBe(true)
    expect(result.jjCalls.some((call) => call.startsWith("restore:"))).toBe(false)
    expect(result.fork.warnings.join(" ")).toContain("was created at the lane default")
    // The irreversible effect the fork carried past is disclosed, never reverted.
    expect(result.fork.warnings.join(" ")).toContain(notifyKind)
    expect(result.fork.warnings.join(" ")).toContain("may execute again on the child")
  })

  it("blocks a rewind across an irreversible effect with no handler", async () => {
    const failure = await drive([], () =>
      Effect.gen(function*() {
        const committed = yield* entries
        const frameSeq = seqOf(committed, "flows.time-travel.effect-boundary") - 1
        const timeTravel = yield* TimeTravel
        return yield* Effect.flip(
          timeTravel.rewind({ runId: "ledger-1", frame: { lineageId: "ledger-1/root", seq: frameSeq } })
        )
      }))

    expect((failure as TimeTravelError).code).toBe("irreversible")
  })

  it("compensates the same rewind once the engine composition contributes a handler", async () => {
    const reverted: Array<string> = []
    const result = await drive([{
      kind: notifyKind,
      tier: "irreversible",
      residue: (effect) => `Notification ${effect.id} was retracted, not un-sent.`,
      revert: (effect) =>
        Effect.sync(() => {
          reverted.push(effect.id)
          return { retracted: effect.id }
        }),
      // A retraction cannot itself be retracted; saying so is the point.
      rollback: () => Effect.void
    }], () =>
      Effect.gen(function*() {
        const committed = yield* entries
        const frameSeq = seqOf(committed, "flows.time-travel.effect-boundary") - 1
        const timeTravel = yield* TimeTravel
        const rewound = yield* timeTravel.rewind({
          runId: "ledger-1",
          frame: { lineageId: "ledger-1/root", seq: frameSeq }
        })
        const remaining = yield* entries
        return { rewound, remaining: remaining.length, total: committed.length }
      }))

    expect(reverted).toHaveLength(1)
    expect(result.rewound.assessments.some((assessment) => assessment.classification === "revertible")).toBe(true)
    expect(result.rewound.archive.archived).toBeGreaterThan(0)
    expect(result.remaining).toBeLessThan(result.total)
  })
})
