---
status: queued
anchor: head
priority: p1
---

# Journal consensus: injectable strategy, then fold the stores

Implement `docs/specs/Concepts/Journal Consensus.md` (will's 2026-08-19
ruling): the journal is the only durable contract, the journal owns the
consensus rules R1–R6, and consensus is an injectable strategy.

Stage 1 — the consensus seam (this item's landing gate):

- Add `Consensus` to `@smthrs/journal` beside `OwnerId`: the service surface
  from the note (`claim`, `activate`, `heartbeat`, `release`, `steal`,
  `guard`), typed rejection reasons, effect-repo naming
  (`make`/`layer`/`layerNoop`), JSDoc with `@since`/`@category`.
- `layerLocal`: in-memory single-process strategy, browser-safe, exact R3.
- `SqlConsensus.layer`: today's `flows_runs` CAS mechanics relocated into a
  strategy-owned lease table (owner tuple, two-phase claim columns,
  `recoverClaim`, generation fence). `guard` joins the append transaction via
  `DurableWriter` savepoints.
- Rewire `Journal.emitDurable`/`checkpoint`/`compact` fencing through the
  injected strategy; `fence_lost` semantics and signatures unchanged.
- Re-base `@smthrs/run-store`'s `Ownership` onto the strategy: it keeps its
  public API and rules but delegates arbitration; its heartbeat supervision
  loop drives `Consensus.heartbeat`.
- Append ownership-transition events (claimed/activated/released/stolen/
  expired) per R6; heartbeats never enter the journal.
- Tests: the existing ownership/fencing suites pass against BOTH
  `layerLocal` and `SqlConsensus.layer` (one shared conformance suite,
  Bazel `GraphTester` style); TestClock-driven staleness/steal cases; a
  commit-after-fence-loss test pinning R3.

Stage 2 — the fold (follow-up items, do not block stage 1): run/attempt
state, step cache, and deferred/clock tables become journal folds with
rebuildable materializations, per the note's fold table. File one queue item
per store when stage 1 lands.

Constraints:

- Reference corpus first: `reference/effect` `unstable/eventlog` (deviation:
  exclusive-writer admission, not conflict merge) and `reference/temporal`
  fencing, as recorded in the note.
- No behavior change to `emitLossy`, channel semantics, or the migration
  id-block scheme.
- The three open questions in the note stay open; record evidence if an
  answer is learned, do not guess.

Round 2 (re-queued 2026-08-20 after verify run-1787173133586 rejected round
1). Round 1's seam is COMMITTED on the lane worktree
`.smithers/workflows/.worktrees/queue-0008-journal-consensus` as commit
`c31aa352` (rescue ref `queue/0008-journal-consensus`); verify judged it
design-conformant but found two composed-engine regressions and three
contract gaps. CONTINUE FROM THAT COMMIT, do not restart. Baseline control
(scratch clone at merge-base 3847343e): engine-store 681/681 and
engine-harness 124/124 were green before the diff. Fix all five:

1. DEADLOCK (most serious): `RunStore.transitionOwned` re-enters
   `journal.transact` via `writeOwnership` and calls `journal.emitDurable`
   (the R6 `recordTransition`) while the outer write transaction holds the
   allocation semaphore; `RunDriver.transitionAndRecord`
   (packages/engine-store/src/internal/RunDriver.ts:333) already wraps it in
   `journal.transact`, so the composed driver parks forever at
   `SqlJournal.ts:1131`. Five engine-harness `HarnessExecutor.test.ts` cases
   hang. R6 events must join the enclosing transaction (the SqlJournal
   `Settlements` parked-thunk pattern) instead of re-acquiring the
   allocation permit inside it.
2. engine-store fixtures and pins (9 failures): `test/JournalFencing.test.ts`
   fixtures still establish ownership by inserting into `flows_runs`, which
   `Consensus.guard` no longer reads; `test/Migrations.test.ts`'s composed
   whole-schema assertion lacks `flows_consensus_leases`;
   `test/HardKillReclaim.test.ts` cannot reclaim a `running` run that has no
   lease row (see 3); `test/RestoreDrill.test.ts` times out (likely the
   deadlock in 1).
3. LEASE BACKFILL: `migrations/0003_consensus.ts` creates an empty lease
   table and abandons every pre-migration `running` run (owner columns but
   no lease: heartbeat `FenceLost`, steal `evidence_invalid`, every fenced
   append `fence_lost`). Backfill leases from the `flows_runs` owner/claim
   columns it relocates, and make `steal`/`recover` able to reclaim a
   lease-less running run with valid liveness evidence.
4. MIGRATION COUPLING: `RunStore.layer` now hard-requires the journal's
   `flows_consensus_leases`. Declare it: compose or document the journal
   `MigrationSet` prerequisite in `packages/run-store/src/Migrations.ts` and
   the README (its `Migrations` row still claims the set covers only
   `flows_runs` and `flows_attempts`).
5. README parity: document `recover`/`Recovered`/`RecoverOutcome`; there is
   no `FenceLost` type (guard fails with `ConsensusError` code
   `"fence_lost"`); add `SqlJournal.layerWith` and `RunStore.layerWith` to
   the export tables. Also strip the blank-line-at-EOF warnings in
   factory/queue/0009-0011.

Round 2 landing gate: everything in the Stage 1 gate above PLUS
engine-store 681/681, engine-harness 124/124 (the pre-existing coverage
threshold red at the baseline is acceptable), and
`pnpm --recursive --if-present run check` green. Note origin/main has
advanced past the lane parent; rebase at land.
