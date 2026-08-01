# Design decisions

This page records the architectural decisions that explain the current source layout. It is a compact rationale index; linked concept pages contain operational detail and package references contain exact APIs.

## D1. Durable execution is application-neutral

Flow payloads, activity inputs, and journal events remain application-defined values so the engine can be embedded without adopting a higher-level application model.

Consequence: the journal uses an open `eventType` plus `payload` envelope, and the engine records engine-specific events without closing the union around one application.

## D2. Flow bodies replay; activities record effects

A resume re-enters the registered handler from the top. Application effects must cross `Activity`, `DurableDeferred`, clock, or another recorded boundary. This is the basis of [deterministic replay](../concepts/determinism-and-replay.md).

Consequence: local computation between boundaries must be deterministic, while activity outputs may be nondeterministic because their encoded result is recorded.

## D3. Key computation sits above storage

`@smithers/engine` computes content or ordinal step keys before calling `FlowEngine.Encoded.activityExecute`. Memory and durable engines therefore receive the same identity instead of implementing key policy independently.

Consequence: activity names are diagnostic. A sealed content identity, not the name, controls reuse.

## D4. Cache admission requires evidence

A content key alone does not prove hermetic execution. `@smithers/engine-store` caches only sealed activities that carry a hard `StepBoundary` descriptor and settle without a deviation.

Consequence: cross-run cache admission requires the filesystem-backed `StepBoundary.layer` (or a stronger host boundary). It measures declared read sets and materializes declared outputs; writes outside the declared sets are only detected within the read set until a jj-diff-backed boundary lands.

## D5. Host access is closed and decorated

The Host surface is exactly FileSystem, Path, Shell, PTY, Jujutsu, and one-hop HTTP, with Effect Clock and Random treated as swappable built-ins. The kernel decorates these services rather than asking each flow to remember permission checks.

Consequence: ambient authority can only shrink through `CapabilitySet.attenuate`, and capability failures stay in the Effect error channel when callers use kernel service tags.

## D6. The journal becomes the authoritative logical WAL; only telemetry admission is optimistic

The target architecture makes the journal flows' own authoritative logical (domain) write-ahead log. The SQLite or PostgreSQL WAL beneath it is the storage durability substrate only, and is never consumed as the application event API.

Lifecycle evidence takes the durable channel: `emitDurable` (and `emit` with an owner, or under `allocation: "sql"`) allocates inside the write transaction and returns only once the row is committed. A durable boundary must not advance the run or expose its result before that commit. Telemetry takes `emitLossy`, a bounded non-blocking queue whose `Dropped` receipts and evictions are accepted outcomes; `flush` is the explicit barrier for that channel.

Consequence: a lossy `Accepted` receipt is not a durability guarantee — process failure can lose accepted but unflushed telemetry, and dropping overflow policies create valid sequence holes. Nothing may be reconstructed from telemetry alone. Local commit is also not remote atomicity: external effects still need idempotency keys, fencing tokens, or compensation.

Open production blocker: executable authority still lives in `RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState`; a state transition and its lifecycle entry are two separate transactions. See [implementation status](implementation-status.md).

## D7. One owner drives a run

Run execution begins only after exact-snapshot claim and activation compare-and-swaps. Heartbeats fence continuing work, and stale-owner takeover requires liveness evidence.

Consequence: all starts and wakes pass through `RunCoordinator` and the same claim path. Durable state mutation must not invoke a handler directly.

## D8. Failure policy follows effect tier

The implemented tiers are sealed, compensable, and irreversible. Sealed work may replay from cache; compensable work restores a Jujutsu snapshot before retry; irreversible retry requires an idempotency key.

Consequence: a proposed graph-wide `halt`/`quarantine`/`continue` policy is not part of the current API. See [failure and retry](../concepts/failure-and-retry.md).

## D9. Time travel is a separate protocol

Replay is read-only. Fork creates a new run prefix and workspace. Rewind is an ownership-fenced protocol with preflight, audit, compensation, workspace restore, atomic archive/truncation, and startup recovery.

Consequence: time travel depends on explicit effect-boundary records, lineage edges, and snapshot pointers. Engine execution does not populate all of those records automatically today.

## D10. Remote sync is read-only

`@smithers/sync` exports catch-up and follow RPCs over journal entries. Mutation, resume, and permission decisions are deliberately outside this protocol.

Consequence: consumers can rebuild read models without acquiring run ownership or receiving write authority.
