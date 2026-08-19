---
status: in-progress
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
