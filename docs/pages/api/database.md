# @smthrs/database

A driver-neutral SQL contract with a bounded write-retry seam. The package owns no domain tables.

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"

const layer = NodeDatabase.layer({ filename: "runs.sqlite" })
```

The root is the contract, so it bundles for the browser. The SQLite drivers are Node-only and live under subpaths.

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/database` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/database/src/index.ts) | any |
| `@smthrs/database/node/NodeDatabase` | [src/node/NodeDatabase.ts](https://github.com/smithersai/flows/blob/main/packages/database/src/node/NodeDatabase.ts) | Node |
| `@smthrs/database/test/TestDatabase` | [src/test/TestDatabase.ts](https://github.com/smithersai/flows/blob/main/packages/database/src/test/TestDatabase.ts) | Node |

## DurableWriter

[src/DurableWriter.ts](https://github.com/smithersai/flows/blob/main/packages/database/src/DurableWriter.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `DurableWriter` | service tag | `flows/database/DurableWriter` |
| `Service` | interface | `sql: SqlClient`, `write: (effect) => Effect` |
| `DatabaseError` | class | carries a `DatabaseErrorCode` |
| `DatabaseErrorCode` | const + type | includes `busy`, `constraint`, `io` |
| `fromSqlError` | function | maps an Effect `SqlError` onto the stable code vocabulary |
| `affectedRows` | function | reads the row count from a driver result |
| `make` | constructor | wraps any Effect `SqlClient` with the retrying `write` |
| `makeNoop` | constructor | every method fails |
| `layerNoop` | layer | |

`write` opens one write transaction and retries the transient categories. Classification covers the SQLite codes and the Postgres SQLSTATEs `40001`, `40P01`, and `55P03` plus PGlite's text forms, normalized onto the same `busy` category.

A backend must run write transactions serializably. `packages/database/test/contract/DatabaseWriteContract.ts` is the conformance suite for that requirement.

## NodeDatabase

[src/node/NodeDatabase.ts](https://github.com/smithersai/flows/blob/main/packages/database/src/node/NodeDatabase.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `NodeDatabaseOptions` | interface | `filename`, optional `sqlite` config, plus write-retry options |
| `layer` | layer | `node:sqlite` through `@effect/sql-sqlite-node`, WAL enabled |

`layer` retries connection opening while SQLite reports the file locked, because the driver issues `PRAGMA journal_mode = WAL` inside its constructor with no busy timeout.

## TestDatabase

[src/test/TestDatabase.ts](https://github.com/smithersai/flows/blob/main/packages/database/src/test/TestDatabase.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `layer` | layer | in-memory SQLite for deterministic suites |

## Dialect status

SQLite is the shipped backend, in both the Node file form and the in-memory test form. Postgres and PGlite layers, and a dialect-parameterized migration ladder, are Planned.
