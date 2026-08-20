---
status: landed
anchor: head
priority: p1
---

# Fold deferred completions and clock deadlines into the journal

Implement the deferred/clock row in the fold table from
`docs/specs/Concepts/Journal Consensus.md`: `flows_deferred_completions` and
`flows_clock_deadlines` become rebuildable materializations of journal events.

- Keep `@smthrs/engine-store`'s durable deferred and clock behavior while
  moving the durable contract to journal events.
- The derived deadline/completion tables may remain as wakeup indexes, but a
  restart must be able to rebuild them from the journal.
- Preserve first-completion-wins deferred semantics, clock scheduling/cancel
  semantics, and existing resume scheduling behavior.
- Preserve `DurableWriter` savepoint atomicity between journal appends and the
  wakeup materialization updates.
- Add rebuild/conformance tests that compare the live indexes with a replayed
  fold across completion, duplicate completion, scheduled deadline, cancelled
  deadline, and restart recovery paths.

Round 2 (re-queued 2026-08-20). Round 1 was APPROVED by verify
run-1787198266011 — the implementation is correct and its tests are real.
It could not land for two reasons, neither of which is a defect in your work:

1. main was rebuilt by a history retell while you were running, so the lane
   has no usable ancestry with it, and the operator has since restored and
   landed on top of it. Current main is `8bef6fbe0` and is GREEN (journal
   181/181, step-cache 80/80, engine-store 687/687, flows 302/302, run-store
   132/132). Your approved work is at lane commit `c9b274c26`. Re-apply it
   onto current main; a three-way merge with `--merge-base=7f17dfc2e` gets
   most of the way and leaves three conflicts.

2. SEMANTIC CONFLICT with item 0010, which landed first (the step-cache
   fold). Both folds independently invented a way to bypass the journal's
   write-path redactor, and only one may survive:
   - 0010 (now ON MAIN): a central allowlist in
     `packages/journal/src/Redaction.ts` —
     `verbatimNamespaces: ReadonlyArray<string> = ["flows.cache."]` with
     `isVerbatimEventType(eventType)` matching by `startsWith`.
   - 0011 (yours): a per-entry `verbatim: Schema.optional(Schema.Boolean)`
     flag on `JournalEvent.Input`, set by your `foldInputEvent` helper.

   ADOPT THE ALLOWLIST AND DROP THE PER-ENTRY FLAG. Rationale, which you
   should preserve in the docs: redaction is a security control, and a
   producer-set flag lets any caller opt its own entries out of redaction,
   whereas the allowlist keeps the policy in the journal where it is
   auditable in one place. The allowlist already anticipates this — its
   comment says other folds join the list.

   Do NOT add `"flows.engine."` to the list. That namespace contains many
   non-fold event types (attempt-started, attempt-finished, cache-conflict,
   cache-corruption, cache-provenance, copy-back-settled,
   diff-bundle-captured, ...) and exempting them all would be a security
   regression. `isVerbatimEventType` matches by prefix, so a FULL event-type
   string works as an exact entry: list precisely your five fold-input types
   and no more. Keep your test that a token-shaped deferred exit survives the
   redactor — it must still pass through the allowlist path.

   The three merge conflicts are `packages/journal/src/SqlJournal.ts`,
   `packages/journal/test/Redaction.test.ts` (both the redactor decision
   point) and `packages/flows/test/vitestCoverageIsolation.test.ts` (the
   coverage-ignore allowlist, which both folds edited).

Round 2 landing gate: journal, run-store, step-cache, engine-store, flows,
control, time-travel all green on `run check` and `run test --run`; the
vault gate clean; and no new entry in `verbatimNamespaces` beyond your five
exact fold-input event types. Run targeted package gates first and commit
early — the 90-minute node timeout has killed attempts on this queue before.
