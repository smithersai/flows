# `@smithers/database`

This page is the public API reference for the thin SQL transaction service. `@smithers/database` owns driver composition and normalized database failures; journal tables and queries belong to `@smithers/journal`.

## Import

```ts
import { Database, NodeDatabase, TestDatabase } from "@smithers/database"
```

## `Database`

| Export | Purpose |
| --- | --- |
| `Database` | Effect service tag exposing `sql` and `write` |
| `DatabaseService` | Structural service interface |
| `DatabaseError` | Schema-tagged failure with `code` and optional `cause` |
| `DatabaseErrorCode` | `busy`, `constraint`, `io`, `unsupported`, or `unknown` |
| `make(sql, options?)` | Wrap an existing Effect `SqlClient` |
| `fromSqlError(error)` | Normalize an Effect SQL error |
| `makeNoop()` | Unsupported database stub |
| `layerNoop` | Layer for the unsupported stub |

`Database.write(effect)` runs `effect` through `sql.withTransaction` and applies bounded retry to retryable writes. The retry classifier is deliberately dialect-blind: it recognizes the SQLite lock/busy/IO codes *and* the Postgres transient SQLSTATEs (`40001` serialization_failure, `40P01` deadlock_detected, `55P03` lock_not_available, plus the text forms PGlite raises without a SQLSTATE), and `fromSqlError` normalizes both onto the same `busy` code. `Database.make` accepts any `SqlClient`, so a caller-supplied Postgres or PGlite client gets the retry behaviour rather than silently getting none (issue #78). A unique violation is never retried — it is the first-writer-wins signal the stores decide on. Other SQL failures are normalized without retry.

**Serialization is part of the `write` contract, not an incidental property.** An implementation MUST guarantee that two concurrent `write` transactions are mutually serialized: they may not both commit results computed from snapshots that exclude each other's writes. Consumers rely on this for correctness rather than isolation hygiene — the engine store closes a run-parent edge by inserting into a table whose `PRIMARY KEY (child_id, parent_id)` supplies the uniqueness and then walking the ancestor graph *inside the same* `write`, and its safety argument ("of two edges that jointly close a cycle, exactly the later one fails") holds only under serialized writers. SQLite meets the contract with its single-writer transaction lock. A PostgreSQL- or PGlite-backed implementation must run write transactions at `SERIALIZABLE` and retry `40001` (which the dialect-blind classifier above already does); plain `READ COMMITTED` does not satisfy the contract, and adopting it would silently reintroduce the cycle race (issue #74).

The contract is pinned by a reusable conformance suite: `packages/database/test/contract/DatabaseWriteContract.ts` exports `describeContract(harness)`, and `test/DatabaseWriteContract.test.ts` runs it against two `NodeDatabase` connections over one file and against the shared in-memory `TestDatabase` connection. **A new backend layer is not done until it is added there** — a harness supplies two `Database` services over one store, and the suite checks no lost update on a concurrent read-modify-write, exactly one winner for two check-then-insert writers over a table with no unique index, cross-connection visibility of a committed write, and whole-transaction rollback. A `READ COMMITTED` implementation fails the first three (issue #97).

```ts
const save = Effect.gen(function*() {
  const database = yield* Database.Database
  yield* database.write(database.sql`insert into items (id) values (${id})`)
})
```

## `NodeDatabase`

`NodeDatabase.layer({ filename, sqlite?, ...retryOptions })` provides the database over `@effect/sql-sqlite-node`. The underlying client enables WAL by default unless its configuration overrides that behavior.

Opening the connection is retried while SQLite reports the database as locked. The client opens the file and issues `PRAGMA journal_mode = WAL` inside its constructor with no busy timeout, so two processes opening one file concurrently can collide there — either on the WAL conversion itself (SQLite refuses a mode change while another connection holds the file, and refuses immediately, without consulting the busy handler) or with `SQLITE_BUSY_RECOVERY` while a peer recovers the log. Both arrive as construction-time defects rather than the `SqlError` values `WriteRetry` classifies, so they are handled at the layer instead. Both clear once the peer finishes; a defect that is not a lock is raised on the first attempt.

```ts
const DatabaseLayer = NodeDatabase.layer({
  filename: "./flows.sqlite"
})
```

## `TestDatabase`

`TestDatabase.layer` is `NodeDatabase.layer({ filename: ":memory:" })`. It is deterministic within one layer scope and has no restart durability.

## Runtime notes

The database service does not run domain migrations. Compose [`Journal.Migrations.layer`](journal.md#migrations) before exposing journal stores.

**Shipped backends are SQLite only.** `NodeDatabase` wraps `@effect/sql-sqlite-node`; the browser counterpart wraps Effect's sqlite-wasm OPFS worker. There is no `PgDatabase`/`PGliteDatabase` layer, and the journal migration ladder is SQLite-flavoured DDL, so a Postgres client wrapped by `Database.make` gets correct retry classification but not a runnable schema. This is an accepted, documented gap with a plan — see new gap 4 in [`../architecture/smithers-replacement-gaps.md`](../architecture/smithers-replacement-gaps.md).

See [Assembling a durable engine](../guides/durable-engine.md) and the [`@smithers/journal` reference](journal.md).
