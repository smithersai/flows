/**
 * The fork verb: a new run seeded from a parent frame, never a parent mutation.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork: fork never touches the parent —
 * no compensation, no truncation, no restore of the parent's workspace — but
 * the boundary assessment still runs, and its result is **normalized to
 * warnings**: "this effect may execute again on the child". A fork with
 * warnings is a successful fork that disclosed something, not a refused one.
 *
 * @since 0.1.0
 */
import { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as EffectBoundary from "../EffectBoundary.ts"
import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { type Fork as ForkResult, TimeTravelStore } from "../TimeTravelStore.ts"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"

/** @since 0.1.0 @category models */
export interface ForkOptions {
  readonly parentRunId: string
  readonly frame: Frame
  readonly workspaceName: string
  readonly workspacePath: string
  readonly pageSize?: number | undefined
}

/**
 * Reads the journal suffix a fork carries past — the entries the child will
 * diverge from, and therefore the effects it may re-arm.
 */
const suffixAfter = (
  journal: Journal.Service,
  runId: string,
  frame: Frame,
  pageSize: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, TimeTravelError> =>
  Effect.gen(function*() {
    const entries: Array<JournalEvent.Entry> = []
    let after = frame.seq as JournalEvent.Seq
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        after,
        limit: pageSize
      }).pipe(Effect.mapError((cause) => error("unknown", `could not read fork suffix for ${runId}`, cause)))
      entries.push(...page.entries)
      if (!page.hasMore || page.entries.length === 0) return entries
      after = page.entries.at(-1)!.seq
    }
  })

/**
 * Turns a boundary assessment into fork warnings.
 *
 * Smithers' `normalizeBranchReport` is the prior art: blocking and revertible
 * entries both become warnings on a branch operation, because the fork will
 * never revert a parent effect. A `warning` entry keeps its own disclosure.
 */
const normalize = (
  assessments: ReadonlyArray<Compensation.Assessment>
): ReadonlyArray<string> =>
  assessments.map((assessment) =>
    assessment.classification === "warning"
      ? `${assessment.effect.kind} (${assessment.effect.id}): ${assessment.residue}`
      : `${assessment.effect.kind} (${assessment.effect.id}) was classified ${assessment.classification} for rewind; ` +
        `on a fork it is never reverted and may execute again on the child. ${assessment.residue}`
  )

/** @since 0.1.0 @category constructors */
export const fork = (
  options: ForkOptions
): Effect.Effect<
  ForkResult,
  TimeTravelError,
  | CacheStore.CacheStore
  | EffectHandlerRegistry
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
  | TimeTravelStore
> =>
  Effect.fn("Fork.fork")(() =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const parent = yield* runs.get(options.parentRunId).pipe(
        Effect.mapError((cause) => error("unknown", "could not read parent", cause))
      )
      if (parent.status === "running" || parent.claim !== null || parent.owner !== null) {
        return yield* Effect.fail(error("live_parent", `parent run ${options.parentRunId} is live`))
      }
      const store = yield* TimeTravelStore
      const journal = yield* Journal.Journal

      // Assessment BEFORE any mutation, exactly as a rewind does — the fork
      // simply refuses to act on the verdict beyond disclosing it.
      const snapshot = yield* store.snapshotAt(options.parentRunId, options.frame)
      const suffix = yield* suffixAfter(journal, options.parentRunId, options.frame, options.pageSize ?? 100)
      const plan = yield* Compensation.assess(EffectBoundary.fromEntries(suffix), snapshot?.changeId)
      const warnings = normalize(plan.assessments)

      const result = yield* store.createFork(options.parentRunId, options.frame)
      const jj = yield* Jj
      yield* jj.workspaceAdd(options.workspaceName, options.workspacePath).pipe(
        Effect.mapError((cause) => error("unknown", "could not add fork workspace", cause))
      )
      yield* Effect.addFinalizer(() => jj.workspaceForget(options.workspaceName).pipe(Effect.ignore))
      // The child gets its own worktree RESTORED FROM THE FRAME'S POINTER. A
      // fresh workspace otherwise starts at whatever the parent's tree happens
      // to hold now, which is the one state the fork is explicitly not forking
      // from. A frame with no anchor restores nothing and says so.
      if (snapshot === undefined) {
        return {
          ...result,
          warnings: [
            ...warnings,
            `Frame ${options.frame.lineageId}@${options.frame.seq} has no recorded jj pointer; ` +
            `the fork workspace ${options.workspaceName} starts from the lane default rather than the frame.`
          ]
        }
      }
      yield* jj.restore(snapshot.changeId).pipe(
        Effect.mapError((cause) => error("unknown", `could not restore fork workspace to ${snapshot.changeId}`, cause))
      )
      return { ...result, warnings }
    })
  )()
