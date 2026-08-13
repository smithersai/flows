# SQLite Operating Envelope

This page is the operator contract for a durable store backed by
`@smthrs/database-next/node/NodeDatabase`. Each assertion points at the source,
test, or upstream database/client document that establishes it.

## Supported Backend

The shipped production database layer is SQLite on Node: `NodeDatabase.layer`
passes a filename and optional `sqlite` driver options through to
`@effect/sql-sqlite-node/SqliteClient` (`packages/database/src/node/NodeDatabase.ts`).
`TestDatabase.layer` is the same stack over `:memory:` and is for tests, not
restart durability (`packages/database/src/test/TestDatabase.ts`).

The package root is browser-bundleable because it exposes the `DurableWriter`
contract, not a driver (`packages/database/src/index.ts`,
`docs/pages/package-structure.md`). Running a durable browser engine still
requires a browser SQL client supplied by the application. This repository does
not ship a sqlite-wasm, OPFS, PGlite, Postgres, or other browser database layer
(`docs/architecture/browser-support.md`, `docs/pages/package-structure.md`).

Postgres and PGlite are not parity backends today. `DurableWriter.make` accepts
any Effect `SqlClient`, and its classifier recognizes Postgres SQLSTATEs and
PGlite text forms (`packages/database/src/DurableWriter.ts`,
`packages/database/src/internal/WriteRetry.ts`,
`packages/database/test/DurableWriter.test.ts`). That only covers retry
classification. The migration ladder and engine-owned schema still include
SQLite-specific DDL, and `packages/engine-store/src/internal/EngineStateSchema.ts`
marks the `flows_run_parents_gc` trigger as SQLite-only; the catalog test pins
that inventory (`packages/engine-store/test/OutOfLadderSchema.test.ts`).

## Connection Settings

For `@effect/sql-sqlite-node@4.0.0-rc.108`, the installed SQLite client opens
`node:sqlite`, sets `PRAGMA busy_timeout` from `busyTimeout` with a five-second
default, then sets `PRAGMA journal_mode = WAL` unless `disableWAL` is true
(`node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts`). The same source
sets writable transactions to `BEGIN IMMEDIATE`.

No repository code in the SQLite path sets `PRAGMA synchronous`,
`PRAGMA wal_autocheckpoint`, or `PRAGMA journal_size_limit`; the PRAGMA grep for
the stack finds the client `busy_timeout` and `journal_mode` writes plus test-only
constraint toggles. Operators should treat SQLite's defaults for those knobs as
the active behavior unless they pass driver options outside this repository.

`NodeDatabase.layer` adds one construction-time retry wrapper around the driver
layer. The code retries locked or busy open failures because WAL conversion and
WAL recovery can fail while another process has the database file open
(`packages/database/src/node/NodeDatabase.ts`). The concurrent-open test holds a
write lock, proves a later layer build waits instead of failing, and verifies the
file remains in WAL mode after the first successful open
(`packages/database/test/NodeDatabaseConcurrentOpen.test.ts`).

## Write Contention

SQLite WAL permits many readers but only one writer at a time; SQLite's own WAL
documentation states that readers and a writer can proceed concurrently, but
there is still only one WAL writer
([sqlite.org/wal.html](https://www.sqlite.org/wal.html)). Effect's Node SQLite
client also serializes access to its one connection with a semaphore and starts
writable transactions with `BEGIN IMMEDIATE`
(`node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts`).

`DurableWriter.write` is the repository write boundary. It runs the effect
through `sql.withTransaction`, retries only the outermost transaction, and lets
nested writes join as savepoints (`packages/database/src/DurableWriter.ts`).
`WriteRetry` retries SQLite busy/locked/I/O errors plus the Postgres transient
vocabulary; it never retries constraint failures
(`packages/database/src/internal/WriteRetry.ts`,
`packages/database/test/DurableWriter.test.ts`). The conformance suite requires
two concurrent writers over one store to serialize without lost updates and to
roll back failed transactions whole
(`packages/database/test/contract/DatabaseWriteContract.ts`,
`packages/database/test/DatabaseWriteContract.test.ts`).

Current upstream defect: Effect-TS/effect#7235 reports that when
`SqlClient.withTransaction` cannot start `BEGIN IMMEDIATE` under contention, the
failure branch tries to roll back even though no transaction exists. The symptom
is an unrecoverable defect containing `cannot rollback - no transaction is
active`, so our busy classifier never sees the typed `SqlError`. Our fix is
Effect-TS/effect#7236, which moves begin/savepoint outside the rollback region
and adds client and driver tests for typed failure propagation
([issue #7235](https://github.com/Effect-TS/effect/issues/7235),
[PR #7236](https://github.com/Effect-TS/effect/pull/7236)).

## Multi-Process Rules

Multiple local processes may open the same SQLite file, and this repository tests
the concurrent-open race described above. WAL itself requires all database
processes to be on the same host filesystem because the WAL index uses shared
memory; do not operate the same WAL database from separate hosts or a network
filesystem ([sqlite.org/wal.html](https://www.sqlite.org/wal.html)).

Every engine process that drives runs must mint a distinct `OwnerId` with
`hostId`, `pid`, and `nonce` (`packages/engine-store/src/OwnerIdentity.ts`).
Run ownership is enforced by compare-and-swap predicates over owner and
heartbeat columns: claim, heartbeat, transition, and steal all update only the
matching row/fence (`packages/run-store/src/RunStore.ts`). The heartbeat
constants and the documented overlap caveat for non-durable side effects live in
`packages/run-store/src/Heartbeat.ts`, and journal durable emits reject zombie
owners in `packages/engine-store/test/JournalFencing.test.ts`.

Opening a read-only inspection connection is a driver capability
(`SqliteClientConfig.readonly` in
`node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts`), but an engine driver
is not read-only: it must write run rows, attempt rows, cache rows, and durable
journal entries. A restarted driver also needs the flow implementations
registered in memory before it can drive stored runs (`docs/pages/architecture.md`).

## Files And Backup

With WAL enabled, a database named `flows.sqlite` can have `flows.sqlite-wal`
and `flows.sqlite-shm` beside it. SQLite documents the `-wal` file as persistent
database state that must stay with the main file when copied or moved, and
documents the `-shm` sidecar as the WAL index shared-memory file
([sqlite.org/wal.html](https://www.sqlite.org/wal.html)). Do not copy only the
main file while the database may have committed frames in `-wal`.

For an online backup, prefer the driver's backup API. The installed client
exposes `backup(destination)` and implements it with `node:sqlite`'s backup
function (`node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts`). SQLite's
backup API is intended for online backup of a running database, though it may
still encounter `SQLITE_BUSY` if it cannot obtain a needed lock
([sqlite.org/backup.html](https://www.sqlite.org/backup.html)). That backup API
is not wrapped in `DurableWriter`; callers that need retries must add them at
the backup call site.

For a raw filesystem copy, quiesce all writers and readers first or copy the
main file and all sidecars that exist as one unit. The repository does not ship a
checkpoint/truncate command, and it does not configure a custom WAL checkpoint
policy.

## Growth And Bounds

The main SQLite file grows with the durable tables. This repository does not
ship a database-wide prune job. `flows_journal_events` is the append-only
logical WAL; public observability docs list journal checkpointing or compaction
as planned, not implemented (`docs/pages/observability.md`,
`docs/architecture/implementation-status.md`).

SQLite's physical WAL file is bounded by SQLite checkpoint behavior, not by a
repository setting. SQLite documents automatic checkpointing by default, but also
documents unbounded WAL growth when checkpointing is disabled, starved by
continuous readers, or delayed by large write transactions
([sqlite.org/wal.html](https://www.sqlite.org/wal.html)). Since this repository
does not set `wal_autocheckpoint` or `journal_size_limit`, use SQLite's defaults
and monitor long readers.

Some row families have local bounds. Attempt checkpoints default to a 1 MiB
encoded-size cap and accept a configured `maxCheckpointBytes`
(`packages/run-store/src/AttemptStore.ts`), with tests covering smaller and
larger configured caps (`packages/run-store/test/AttemptStoreOptions.test.ts`).
Run-parent edge cleanup is enforced by the SQLite `flows_run_parents_gc` trigger
when a run row is deleted (`packages/engine-store/src/internal/EngineStateSchema.ts`,
`packages/engine-store/test/RunParentAtomicity.test.ts`).

Content-addressed cache/artifact growth is not globally garbage-collected here.
`CombinedCacheStore.evict` is local-only and leaves shared CAS reclamation to the
ticketed release verb (`packages/step-cache/src/CombinedCacheStore.ts`), and the
implementation-status page lists artifact garbage collection as planned
(`docs/architecture/implementation-status.md`).
