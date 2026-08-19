---
status: queued
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

