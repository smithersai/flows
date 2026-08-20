---
status: landed
anchor: head
priority: p1
---

# Fold run and attempt state into the journal

Implement the run/attempt row in the fold table from
`docs/specs/Concepts/Journal Consensus.md`: `flows_runs` status/lineage and
`flows_attempts` become rebuildable materializations of journal events.

- Keep `@smthrs/run-store`'s public `RunStore` and `AttemptStore` APIs while
  moving their durable contract to journal events.
- The materialized tables may stay for fast recovery, but dropping them and
  replaying the journal must rebuild equivalent state.
- Preserve the Stage 1 consensus seam: owner/claim lease data remains
  strategy-private in `SqlConsensus`, not a fold.
- Preserve `DurableWriter` savepoint atomicity between appends and
  materialization updates.
- Add rebuild/conformance tests that compare the live materialization with a
  replayed fold across lifecycle, cancellation, waiting, terminal, and attempt
  mutation paths.

Stage 1 has landed (flows main `361677714`, item 0008 done). Build on it:
`Consensus` + `SqlConsensus` + `layerLocal` are in `@smthrs/journal`,
`emitDurable`/`checkpoint`/`compact` admit through `Consensus.guard`,
`RunStore` already delegates arbitration and appends R6 transitions with
`meta.lineageId`. Read `docs/specs/Concepts/Journal Consensus.md` first — its
"Stage 1, round 2/round 3" sections are normative and were paid for in three
verify rounds.

Lessons from item 0008 that apply directly to this fold:

- **Test the COMPOSED system, not just the touched packages.** Every 0008
  rejection came from packages that were not in the diff: `engine-store`,
  `engine-harness`, `control`, `time-travel`. This fold changes what
  recovery reads, so those four plus `sync`, `kernel`, and `cli` are the
  real gate. Run them before declaring done.
- **Take a baseline control.** Clone at the merge-base and run the suites
  there first, so a red is provably yours and not pre-existing. 0008's
  verify did this and it settled two arguments.
- **A journal entry that no projection can place is a hole in the journal.**
  R6 entries shipped without lineage meta and crashed `time-travel`'s folds.
  Every event this fold introduces carries the same meta every durable
  append carries, and every consumer that reads a stream positionally must
  select by namespace.
- **A migration must not orphan live state.** 0008's first migration created
  an empty lease table and would have made every already-running run
  permanently undrivable. This fold moves the tables recovery reads: state
  written by the OLD code must still be readable, or be backfilled, and a
  test must prove it.
- **Budget the node's 90 minutes.** 0008 lost an entire attempt to the CLI
  timeout during `pnpm --recursive run check`. Run targeted package gates
  first, commit early and often, and never leave the wide check for last.
- **Commits may fail in the lane sandbox** (`HEAD.lock` permission, and no
  DNS for fetch/push) — smithers bug `01m0e9rmj943cv327vke20vp1k`. Do not
  fight it: report exactly what changed and the operator commits and lands.

Round 2 (re-queued after verify run-1787197271164 REJECTED round 1). Round 1
produced a plausible skeleton — `flows.run.*`/`flows.attempt.*` namespaces, a
`Fold` module with reducers and `rebuild`, migration snapshot backfill — but
it does not compile, its own new tests fail, and it regresses 54 previously
green tests. Round 1's work is COMMITTED on the lane as `29b12642` (the
operator committed it; the lane sandbox denies agent commits, smithers bug
`01m0e9rmj943cv327vke20vp1k`). CONTINUE FROM THAT COMMIT.

Baseline control at the merge-base is FULLY GREEN: run-store 132/132,
journal 177/177, engine-store check clean and 682/682. Every red below is
yours.

THE ROOT DEFECT (fix this first — findings 3 and 5 are one bug):
`AttemptStore.makeWith` (src/AttemptStore.ts:461) and `DurableEngineState.make`
(src/DurableEngineState.ts:684) resolve the journal ONCE at layer-construction
time via `Effect.serviceOption(Journal)`. In every real composition
(`packages/flows/src/NodeRuntime.ts:94-103`,
`packages/engine-store/src/test/TestStores.ts:60-70`,
`packages/time-travel/test/RealTimeTravelHarness.ts:100`) `SqlJournal.layer*`
is a SIBLING in `Layer.mergeAll`, so it is NOT in those layers' construction
context and the option is `None`. Attempt and waiting events are therefore
silently never appended, and `Fold.rebuild` would ERASE `flows_attempts`.
`RunStore` escapes only because `recordRunEvent` re-resolves at call time.
The vault note already commits to the fix: the `RunStore`/`AttemptStore` SQL
layers REQUIRE `Journal` in context ("a row write without its event is a hole
in the contract"), retiring stage 1's serviceOption behavior for the SQL
layers. Do that — it turns this silent data-loss bug into a compile error —
and update the `layerWith` JSDoc at src/RunStore.ts:1450, which still says
events are appended only "when a `Journal` is also in context".

THE REST, all blocking:

1. engine-store does not compile: `src/DurableEngineState.ts:729`
   (`writeRunFold`) unifies `Effect<A, JournalError, R>` and
   `Effect<A, DatabaseError, R>` into the journal-only error type — TS2375
   under exactOptionalPropertyTypes.
2. Both new fold tests fail, so the fold was never actually verified.
   `packages/engine-store/test/RunStateFoldWaiting.test.ts:9,27` imports the
   `RunStore` Context TAG and calls `RunStore.layer` on it; the tag has no
   `layer`, so `Layer.mergeAll` throws "Cannot read properties of undefined
   (reading 'build')". `packages/run-store/test/Fold.test.ts` fails under
   both consensus strategies.
3. 54 previously-green tests regress and no consumer was updated: 6 run-store
   OwnershipConsensus tests fail with `fence_lost` raised by the new fenced
   `flows.run.transitioned` appends inside `activate`/`claimAndOwn`; 48
   engine-store tests fail, including journal event-sequence assertions,
   `RunStore.create` newly propagating a journal `sink_failed` as
   `persistence_failed` (test/ActionEdgeCases.test.ts), and
   TestStores.test.ts seeing seqs [0,1,2,3,4] where it expected [0,1,2].
   Decide per case whether the consumer or the implementation is wrong, and
   say which in your output.
4. Reducers are not journal `Projection`s, which the note promises.
   `Fold.ts` hand-rolls `initial`/`reduce`/`foldEntries` and `rebuild` issues
   its own `SELECT ... FROM flows_journal_events` instead of going through
   `Journal.project` / `packages/journal/src/Projection.ts`.
5. COMPACTION ORPHANS STATE — the same class of failure the queue item
   warns about, moved to a new path. The note says `compact` may drop
   fold-namespace entries below the checkpoint floor ONLY once a `snapshot`
   event at or after the floor captures each surviving row's folded state.
   `SqlJournal.compact` is untouched and still deletes unconditionally, and
   `Fold.rebuild` ignores `flows_journal_checkpoints`. Any compaction —
   including the automatic `CompactionPolicy` — permanently drops
   `flows.run.created`/`flows.attempt.put` and a later rebuild loses those
   runs and attempts.
6. Gate reds to clear: journal 100%-branch coverage fails on the new
   redaction-bypass arm; dprint fails in run-store and engine-store (run
   `pnpm --dir packages/<p> run format`).
7. Vault note gaps to close in `docs/specs/Concepts/Run State Fold.md`: the
   "What each column rebuilds from" table omits
   `waiting_reason`/`waiting_wake_at_ms`/`waiting_token` even though
   `Fold.rebuild` rewrites them; and the note says both namespaces are
   "appended by `@smthrs/run-store`" when `flows.run.transitioned` is also
   appended elsewhere.

Round 2 landing gate: engine-store `check` clean and 682/682 or better;
run-store, journal, engine-store, control, time-travel, engine-harness,
sync, kernel, cli all green; the new Fold suites actually passing; dprint
and coverage green; vault gate clean. Run the targeted package gates FIRST
and commit early — the 90-minute node timeout killed an attempt on item 0008
during a recursive check.

Round 3 (re-queued 2026-08-20 after verify run-1787202867368). Round 2 is a
big step forward: ALL GATES ARE GREEN across twelve packages (run-store
138/138 at 100% coverage, journal 182/182, engine-store 684/684 — above the
682 bar — plus control, time-travel, engine-harness, sync, kernel, cli,
database, flow, flows) and the vault gate is clean. The journal-required SQL
layers, Projection-driven reducers, the rebuild that touches neither the event
table nor the lease table, the redaction bypass, the migration backfill, and
the two-strategy conformance suite are all accepted. Round 2 is COMMITTED on
the lane as `176fe32bb`; the worktree is clean. CONTINUE FROM IT and do not
redo any of the above.

Verify withheld approval on three contract breaches that the suites cannot
see. Fix all three; each needs a test that would fail on round 2's code.

1. BLOCKER — the headline invariant ("at every commit the materialized tables
   equal the fold of the journal") breaks on the cancel-a-parked-run path,
   and every existing test hides it. `DurableEngineState.wake` appends
   `flows.run.transitioned` carrying the run's CURRENT status plus a fresh
   `Clock.currentTimeMillis` (packages/engine-store/src/DurableEngineState.ts:1103)
   and the reducer stamps `finishedAtMs = atMs` for any terminal status
   (packages/run-store/src/Fold.ts:252). `RunDriver.cancelOwned` transitions a
   run to `cancelled` and THEN wakes it in the same transaction, precisely
   because a cancel can race a park
   (packages/engine-store/src/internal/RunDriver.ts:654) — so the wake
   re-stamps `finished_at_ms` LATER than the row holds. Under a real clock the
   two reads are separated by the transition UPDATE, the append, the cascade
   queries and wake's SELECT+UPDATE, so they routinely differ; every fold test
   uses TestClock, where both reads return the same value, which is why the
   suites stay green. Fix: `wake` must not re-assert the lifecycle timestamp
   (emit an event that omits it, or carry the row's existing `finishedAtMs`),
   AND add a cancel-while-parked case to the fold conformance suite that
   ADVANCES THE TESTCLOCK between the transition and the wake, so the case
   fails on round 2's code.

2. BLOCKER — time travel's masked-journal rule is silently retired.
   `Rewind.unjournaled` (packages/time-travel/src/internal/Rewind.ts:352)
   suppresses appends by removing `Journal` from the fiber context, which only
   worked while `RunStore` resolved the journal per call. The fold makes
   `RunStore.make` capture it once at construction
   (packages/run-store/src/RunStore.ts:646), so `unjournaled(...)` is now
   INERT: a rewind's own fencing does append `flows.consensus.*` and
   `flows.run.transitioned` past the frame. The `ownsReplayEntry` namespace
   filter compensates, but `unjournaled`'s JSDoc still claims it fences
   "without appending an R6 ownership-transition event" and the vault note's
   "Rebuild, recovery, and time travel" paragraph still reasons from the
   masked-journal rule. Pick ONE and make everything agree: either restore
   suppression explicitly, or state in both the JSDoc and the vault note that
   the rewind's fencing is journaled and excluded from replay by namespace.
   Do not leave prose describing a mechanism that no longer runs.

3. BLOCKER — journal compaction is now permanently disabled.
   `SqlJournal.compact` refuses whenever a run has fold-namespace entries
   below the floor with no `flows.run.snapshot` at or after it
   (packages/journal/src/SqlJournal.ts:1455), and the ONLY appender of
   `flows.run.snapshot` in `packages/` is migration 0003 plus tests. No store
   or `Fold` export appends a snapshot set during operation, so every run
   accumulates `flows.run.*` entries and every automatic `CompactionPolicy`
   attempt fails with `reader_behind`, is damped, logged, and retried forever.
   SHIP THE RUNTIME HALF: append the snapshot set (the run snapshot plus one
   attempt snapshot per row, in one transaction, as the vault note specifies)
   so that "one mechanism serves compaction, migration backfill, and disaster
   rebuild" is true. Add a test that compaction SUCCEEDS on a run that has
   fold entries below the floor. Do not resolve this by weakening the barrier.

4. NON-BLOCKING docs/impl mismatches to close while you are in there: (a) the
   vault note and both package READMEs describe compaction as RETAINING fold
   entries ("those namespaces simply do not compact"), implying other
   namespaces still compact, when the implementation refuses the whole call
   with a typed `reader_behind` and deletes nothing — only `Journal.ts`'s
   JSDoc records the refusal; (b) the note and run-store's README say a
   refused append surfaces as `persistence_failed`, when the implementation
   maps a journal `fence_lost` to the store's typed `FenceLost` outcome;
   (c) the new Fold module carries 45 `v8-ignore` directives — justify them or
   remove them.

Round 3 landing gate: everything round 2 already achieved, PLUS a passing
cancel-while-parked fold case with an advanced TestClock, a passing
compaction-succeeds case, and no prose anywhere describing a mechanism that
does not run. Targeted gates first, commit early.
