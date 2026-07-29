# @flows/database

@flows/database is the thin SQL boundary for durable packages. It wraps an
Effect SQL client with normalized errors and transaction-scoped SQLite write
retries. Domain schema and queries belong to @flows/journal.

~~~text
NodeDatabase.layer({ filename, ...retryOptions })
  └─ SQLite client → Database.make(sql, retryOptions)
TestDatabase.layer = NodeDatabase.layer({ filename: ":memory:" })
Database.layerNoop = unsupported SQL + writes
~~~

Database.Database exposes sql and write(effect). Database.make wraps an existing
SQL client. makeNoop and layerNoop fail with DatabaseError { code:
"unsupported" }. NodeDatabase.layer is the only deployment database layer in
this package. TestDatabase.layer is the test boundary.

~~~ts
import { Database, NodeDatabase } from "@flows/database"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const db = yield* Database.Database
  return yield* db.write(db.sql\`SELECT 1 AS value\`)
})

Effect.runPromise(Effect.provide(program, NodeDatabase.layer({ filename: "flows.db" })))
~~~

DatabaseErrorCode is "busy" | "constraint" | "io" | "unsupported" | "unknown".
Recognized SQLite busy, locked, I/O, and lock-timeout writes retry with
defaults of 10 total attempts, 50 ms initial delay, and a 10,000 ms delay cap.
The schedule is exponential and jittered. Constraints, syntax errors, and
arbitrary application errors are not retried.

See the [reference](../../docs/reference/database.md) for signatures and
defaults.
