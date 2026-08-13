# Observability

What you can see while a flow runs, and what you cannot. This page lists only surfaces that exist in `packages/*/src` today. Everything absent is named at the bottom rather than left implied.

## The journal is the primary surface

Most of what you would want from an observability stack is already a durable row. Lifecycle evidence goes through `emitDurable`, so it is committed in the same transaction as the state it describes and cannot be dropped.

| Question | Query |
| --- | --- |
| what happened to this run, in order | `Journal.entries({ runId, limit })` |
| what is happening now | `Journal.stream({ runId, afterSequence })` |
| a derived view over history | `Journal.project(projection, options)` |
| the same from another process | `@smthrs/sync-next` `Read` and `Subscribe` |
| the state at a past point | `TimeTravel.inspect(position, projection)` |

The engine event types are listed in [Data structures](/data-structures). Filtering on `event_type` is indexed.

Two properties matter when you build on this. Entries publish after COMMIT, so a subscriber never sees an entry that later rolls back. Sequences may have holes, so a reader follows cursors rather than assuming adjacency.

## Redaction

`Redaction` runs at the single `payload` and `meta` encode chokepoint. `defaultRules` plus `isSensitiveKey` decide what is replaced with the placeholder, and `SqlJournal.layer` takes a `redact` option including an opt-out.

Executable state is deliberately outside that chokepoint. Run state, attempt checkpoints, errors, outcomes and metadata, and cache results round-trip verbatim, because rewriting them resumes a flow with the wrong data and can make persisted state fail to decode. A secret that must not persist belongs in a `Redacted` field of the caller's own state schema.

## Tracing

`@smthrs/flow-next` and `@smthrs/engine-next` open the spans below through Effect's tracer. These packages install no exporter; provide one from your application — `@smthrs/observability-next` is the shipped default, wired on [Telemetry](/telemetry) — and these spans appear in it.

| Span | Attributes | Source |
| --- | --- | --- |
| `<FlowTag>.execute` | none | `@smthrs/flow-next` `Flow/make.ts` |
| `<FlowTag>.poll` | `executionId` | `@smthrs/flow-next` `Flow/make.ts` |
| `<FlowTag>.interrupt` | `executionId` | `@smthrs/flow-next` `Flow/make.ts` |
| `<FlowTag>.resume` | `executionId` | `@smthrs/flow-next` `Flow/make.ts` |
| `<activity name>` | none | `@smthrs/flow-next` `Activity/make.ts`, around every activity dispatch |
| `FlowEngine.deferredResult` | `name` | `@smthrs/engine-next` `FlowEngine/make.ts` |
| `FlowEngine.deferredDone` | `name`, `executionId` | `@smthrs/engine-next` `FlowEngine/make.ts` |
| `FlowEngine.scheduleClock` | `executionId`, `name` | `@smthrs/engine-next` `FlowEngine/make.ts` |
| `DurableQueue/<name>/worker` | parented to the offering span through `Tracer.externalSpan` | `@smthrs/flow-next` `DurableQueue.ts` |

Every span sets `captureStackTrace: false`. The queue worker is the one place trace context crosses a durable boundary: the offer records `traceId`, `spanId`, and `sampled` on the item, and the worker reattaches to that external span, so a persisted queue item stays connected to the flow that offered it.

## Metrics

The store packages define `Metric` counters beside the code that updates them, one `<Service>Metrics` module per package: journal write receipts, durable write replays, run claim and heartbeat and transition outcomes (fencing events included), step-cache lookups and recordings, artifact puts and gets. [Telemetry](/telemetry) tables every counter with its attributes and shows the export wiring; the handles themselves are exported, so a program can read them with `Metric.value` without any exporter.

## Logging

Logging is sparse and deliberate. The engine logs where an operator needs to know something the error channel cannot carry.

| Log | Level | Meaning |
| --- | --- | --- |
| unregistered flow on wake | warning | a sweeper found a parked run for a flow this process never registered; the row stays parked, once per run |
| sweeper defect | warning | a transient failure escaping the sweep, retried next tick |
| deferred persistence failure | warning | a lossy-sink failure after the durable completion already committed |
| queue worker failure | warning | a worker handler cause, before the loop continues |

Log annotations are attached by `DurableQueue` (`package`, `module`, `fiber`, `queueName`) and by `FlowProxyServer` around its handlers. Everything else inherits whatever annotations the caller has set.

## Debugging aids

| Aid | Where | Use |
| --- | --- | --- |
| `Notifying.wrap` and `Notifying.layer` | `@smthrs/journal-next/test/Notifying` | inject a crash or fence loss at a chosen interstitial around any Effect service |
| `TestHost.layer` | `@smthrs/kernel-next/test/TestHost` | in-memory filesystem, scripted command interpreter, seeded random, deterministic clock |
| `TestJournal.layer()` | `@smthrs/journal-next/test/TestJournal` | the SQL journal over in-memory SQLite |
| `TestStores.layer()` | `@smthrs/engine-store-next/test/TestStores` | the four SQL stores over ONE in-memory SQLite database |
| `TestDatabase.layer` | `@smthrs/database-next/test/TestDatabase` | in-memory SQLite |
| `TestSocket.makePair` | `@smthrs/sync-next/test/TestSocket` | a fault-injecting socket pair for sync |
| `DurableEngineState.layerMemory` | `@smthrs/engine-store-next` | deterministic waits with no database |
| `Inconsistency.layerStrict` | `@smthrs/engine-store-next` | fail the run on a cache conflict rather than continuing |
| stable error codes | `EngineStore.Errors` | switch on `code` or `_tag` when triaging |

## What is missing

| Surface | Status |
| --- | --- |
| Latency histograms or gauges; the shipped metrics are counters over outcomes | Planned |
| Documented spans outside `@smthrs/flow-next` and `@smthrs/engine-next` | `@smthrs/database-next`, `@smthrs/journal-next`, `@smthrs/run-store-next`, `@smthrs/step-cache-next`, `@smthrs/plan-next`, `@smthrs/artifacts-next`, `@smthrs/engine-store-next`, `@smthrs/kernel-next`, `@smthrs/sync-next`, and `@smthrs/time-travel-next` each open one `Effect.fn` span per service operation, named after that operation and declaring no attributes; this page does not enumerate them |
| A run inspector or dashboard | Planned; the journal and sync are the substrate one would build on |
| Structured audit of permission decisions beyond the grant events | Planned |
| Journal checkpointing or compaction for unbounded histories | Planned |
