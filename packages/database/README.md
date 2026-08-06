# @smithers/database

Thin Effect SQL boundary for the durable flows packages. It provides a normalized
database service and Node/in-memory SQLite layers; journal schema and queries stay
in `@smithers/journal`.

```sh
npm install @smithers/database
```

## Public API

The root is the driver-neutral contract and bundles for the browser. The drivers
are Node-only — `node:sqlite` through `@effect/sql-sqlite-node` — so they live
under explicit subpaths.

| Import                                 | Public exports                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smithers/database`                   | `Database` and `DatabaseService` expose `sql` plus transaction-scoped `write(effect)`. `DatabaseErrorCode`, `DatabaseError`, and `fromSqlError` normalize driver failures. `make` wraps a SQL client; `makeNoop` and `layerNoop` provide an unsupported stub. |
| `@smithers/database/node/NodeDatabase` | **Node only.** `NodeDatabaseOptions` configures SQLite and write retries; `layer(options)` provides `Database`.                                                                                                                                               |
| `@smithers/database/test/TestDatabase` | **Node only.** `layer` provides the production Node adapter over a fresh `:memory:` database.                                                                                                                                                                 |

Any Effect `SqlClient` can be wrapped with `Database.make`, so a browser or
Postgres client gets the same normalized errors and write retry — see
[browser support](../../docs/architecture/browser-support.md).

```ts
import { Database } from "@smithers/database"
import * as NodeDatabase from "@smithers/database/node/NodeDatabase"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const database = yield* Database.Database
  return yield* database.write(database.sql`SELECT 1 AS value`)
}).pipe(Effect.provide(NodeDatabase.layer({ filename: "flows.db" })))

Effect.runPromise(program)
```

SQLite busy, locked, I/O, and lock-timeout writes are retried. Constraints,
syntax errors, and arbitrary application errors are not.

See the [database reference](../../docs/reference/database.md),
[Journal Queue](../../../docs/specs/Concepts/Journal%20Queue.md), and
[Run Ownership](../../../docs/specs/Concepts/Run%20Ownership.md).
