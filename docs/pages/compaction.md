# Checkpoints and compaction

The journal is an append-only history, and a long-lived run makes it unbounded. Checkpoints and compaction bound it: a checkpoint durably captures the state that replays a run from a journal offset, and compaction deletes the entries strictly below a checkpoint. Both live on the `Journal` service in `@smthrs/journal`. Nothing is deleted unless a caller asks: compaction is explicit or opt-in by policy, never automatic by default.

The design follows Temporal, where the durable "snapshot" is mutable state pinned to a history offset and a reader of trimmed history gets a typed error, never a silently shortened history (`reference/temporal/common/persistence/history_manager.go`).

## Checkpoint

```ts
const checkpoint = yield* journal.checkpoint({
  runId,
  seq,          // a committed sequence of this run
  state         // your replay state, covering every entry with seq <= this one
}, owner)       // optional: fence on run ownership
```

A checkpoint at `seq` asserts: `state` subsumes every entry at or below `seq`, so replay is `state` plus `stream({ runId, afterSequence: seq })`. The journal never interprets `state`; it round-trips verbatim. Redaction deliberately does not apply — checkpoint state is replay input, exactly like executable state, and rewriting it would resume the run with the wrong data. A secret that must not persist belongs in a `Redacted` field of your own state schema.

Rules the write enforces:

- `seq` must name a committed entry. The surviving row is what keeps the run's durable `MAX(seq)` allocation floor at or above the boundary, so a restarted process can never re-mint a truncated sequence.
- `seq` must lie above the run's compaction floor; otherwise the write fails with `checkpoint_invalid`.
- Re-checkpointing an uncompacted `seq` replaces its state. Last writer wins.
- With an `owner`, the write is fenced on the run's persisted ownership like `emitDurable`: a reclaimed run fails with `fence_lost`.

The write shares `Journal.transact`'s discipline. Inside an open `transact` it joins the caller's transaction as a savepoint and rolls back with it, so you can capture state and write the checkpoint describing it atomically.

## Compact

```ts
const receipt = yield* journal.compact({ runId }, owner)   // latest checkpoint
const receipt = yield* journal.compact({ runId, upTo }, owner)
```

Compaction deletes the run's entries strictly below the checkpoint, deletes superseded checkpoints, and marks the checkpoint as the run's compaction floor — all in one write transaction. A crash mid-compaction is unrepresentable as a partial state: either everything committed or nothing did. A retried compaction is idempotent and reports `deleted: 0`.

Compaction refuses rather than guesses:

| Failure | Meaning |
| --- | --- |
| `checkpoint_invalid` | the run has no checkpoint to truncate below |
| `reader_behind` | a live in-process stream still needs a sequence below the boundary |
| `fence_lost` | the supplied `owner` no longer holds the run |

## Readers and followers

Sequence gaps are normal in the journal (rejected admissions consume sequences), so a follower cannot detect compaction by looking for holes. Compacted history is therefore reported explicitly:

- Every live in-process `stream` registers its durable cursor. `compact` refuses with `reader_behind` while any of them is behind the boundary, so a live follower's next page is never deleted out from under it.
- Every other reader — `entries` pollers, `stream` subscribers in other processes, sync followers — is covered on the read side: a read whose cursor starts below the floor fails with `compacted`, carrying `checkpointSeq`, the floor to resync from. `@smthrs/sync` reads through `Journal.entries` and `Journal.stream`, so a remote follower behind the floor sees its read or subscription fail rather than a gapped history.

Resync is three steps:

```ts
const latest = yield* journal.latestCheckpoint(runId)   // Option<Checkpoint>
// 1. discard local derived state; 2. apply latest.state;
// 3. continue from stream({ runId, afterSequence: latest.seq })
```

A projection over a compacted run follows the same rule: start it from the checkpoint, not from sequence zero.

## The policy hook

`SqlJournal.layer` takes an optional automatic policy. It is off by default.

```ts
SqlJournal.layer({
  capacity: 1024,
  overflow: "reject",
  compaction: {
    entryThreshold: 10_000,
    capture: (runId, upTo) => buildReplayState(runId, upTo)
  }
})
```

Once a run's committed entry count reaches `entryThreshold`, the journal calls `capture` for the replay state at the run's durable tail, checkpoints there, and compacts. The count is seeded from the durable history on the run's first committed entry in a process, so a restart still compacts a long pre-existing backlog.

Constraints on `capture`:

- It runs post-commit in the fiber that crossed the threshold. Keep it to storage reads.
- It must not emit through the same journal — the triggering durable emit still holds the allocation permit — and must not call `flush`.
- A failure or a `reader_behind` refusal is logged at warning, damped for `entryThreshold` further commits, and never fails the emit that triggered it.

## Operational guidance

**Choose boundaries that dominate producer retries.** Compaction truncates the durable producer-retry window: a retry of a source event whose row was compacted away is admitted as a new event, not deduplicated. Checkpoint only at sequences where no producer can still retry an event at or below the boundary — in the engine's terms, at quiescent points where every in-flight action outcome is already durable.

**Do not compact runs you intend to fork or rewind below the checkpoint.** `@smthrs/time-travel` forks copy the parent's surviving journal rows; history below the floor is gone. Compaction trades auditability below the boundary for bounded storage — that is its point — so keep full history on runs where the audit trail matters more than the disk.

**Checkpoint state is unbounded by the journal.** Persist a digest or a reference if your replay state is large; the row is a single `state_json` column.

**Dialect.** The implementation ships for the SQLite dialect (the `SqlJournal` all stores share). The PGlite/browser story is a follow-up: the SQL is standard except for the migration's `typeof` checks, and the read-side guard and transactional shape carry over unchanged, but only SQLite is exercised by the test suite today.

## API summary

| Method | Returns | Behavior |
| --- | --- | --- |
| `checkpoint(options, owner?)` | `Checkpoint` | durably captures replay state at a committed sequence |
| `latestCheckpoint(runId)` | `Option<Checkpoint>` | the resync point; `compactedAtMs` non-null once it is the floor |
| `compact(options, owner?)` | `Compacted` | truncates strictly below the checkpoint, atomically with the floor |

Schema: `flows_journal_checkpoints`, migration `journal/0002_checkpoints`, one row per `(run_id, seq)`.
