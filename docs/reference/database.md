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

`Database.write(effect)` runs `effect` through `sql.withTransaction` and applies bounded retry to retryable SQLite writes. The retry classifier recognizes lock/busy failures; other SQL failures are normalized without retry.

```ts
const save = Effect.gen(function*() {
  const database = yield* Database.Database
  yield* database.write(database.sql`insert into items (id) values (${id})`)
})
```

## `NodeDatabase`

`NodeDatabase.layer({ filename, sqlite?, ...retryOptions })` provides the database over `@effect/sql-sqlite-node`. The underlying client enables WAL by default unless its configuration overrides that behavior.

```ts
const DatabaseLayer = NodeDatabase.layer({
  filename: "./flows.sqlite"
})
```

## `TestDatabase`

`TestDatabase.layer` is `NodeDatabase.layer({ filename: ":memory:" })`. It is deterministic within one layer scope and has no restart durability.

## Runtime notes

The database service does not run domain migrations. Compose [`Journal.Migrations.layer`](journal.md#migrations) before exposing journal stores. The Vercel server adapter can wrap a PostgreSQL client, but `Database.write`’s extra write-retry classification remains SQLite-oriented.

See [Assembling a durable engine](../guides/durable-engine.md) and the [`@smithers/journal` reference](journal.md).
