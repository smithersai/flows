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

Landed (2026-08-20). Rounds 2 and 3 on the lane cleared every blocking
finding above; verify approved the round-3 state (`Fold.rebuild` goes
through `Journal` projections, compaction snapshots the fold floor, and the
defensive arms are covered instead of ignored — `run-store/src/Fold.ts`
pinned at 5 ignores). The lane predates the history retell, so the landing
re-applied its seven commits onto the rebuilt main; the cross-lineage
collisions and how they resolved:

- Redaction bypass: item 0010's central allowlist won again, as it did for
  item 0011. `flows.run.` and `flows.attempt.` joined
  `Redaction.verbatimNamespaces` as whole namespaces — every event in them
  is a fold input — and the lane's local `bypassesWriteRedaction` helper was
  dropped.
- Journal-in-context: every composition that had `SqlJournal.layer` as a
  mergeAll sibling (item 0010's memoized `journalLayer` hoist included) now
  provides one journal into all store layers with `Layer.provideMerge`,
  which also retires the hoist's per-store `Layer.provide(journal)`.
- `Rewind.validate` pagination: main's did-not-advance guard and the lane's
  `ownsReplayEntry` filter compose; the guard tracks all entries, the
  replay tail counts only owned ones.
- Item 0011's `engine-store/test/Fold.test.ts` composed its journal as a
  sibling behind a cast; it now provides the journal into
  `DurableEngineState.layer`, whose type requires `Journal` since this fold.
- The lane's engine-harness coverage tweaks were dropped: the rebuilt main
  reorganized that package into `packages/agent`, whose gate passes on its
  own terms.

Landing gate at the merged tip: run-store, journal, engine-store,
time-travel all `check` clean and 100% coverage (132+/189/714/304 tests);
database 75, flow 290, control 145, kernel 410, flows 302 (including the
coverage-ignore inventory), cli 206, step-cache 80 — all green.
