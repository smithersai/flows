import { Duration, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { type ContractSide, describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"

/** Builds one client/writer pair and keeps its connection open for the scope. */
const connect = (layer: Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient>) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(layer as unknown as Layer.Layer<never>)
    const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<SqlClient.SqlClient>)
    const writer = yield* (Effect.service(DurableWriter.DurableWriter).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<DurableWriter.Service>)
    return { sql, write: writer.write }
  })

const fileLayer = (filename: string): Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient> =>
  Layer.provideMerge(
    DurableWriter.layer(),
    NodeDatabase.layer({ filename, sqlite: { busyTimeout: Duration.millis(25) } })
  )

/**
 * The production Node path: two independent connections over one database
 * file, so serialization can only come from the database's own cross-connection
 * write lock. This is the harness a PGlite/Postgres layer must also pass.
 */
const nodeFileHarness: Harness = {
  label: "NodeDatabase, two connections over one file",
  run: (body) => {
    const filename = join(mkdtempSync(join(tmpdir(), "flows-db-contract-")), "contract.sqlite")
    return Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const a = yield* connect(fileLayer(filename))
        const b = yield* connect(fileLayer(filename))
        return yield* body({ a, b })
      })) as Effect.Effect<never>
    )
  }
}

/**
 * The in-memory path used by every other suite. `:memory:` is private to a
 * connection, so both handles are the same pair and serialization comes
 * from the client's in-process transaction mutex rather than the database —
 * a weaker mechanism that must still satisfy the same contract.
 */
const memoryHarness: Harness = {
  label: "TestDatabase, one shared in-memory connection",
  run: (body) =>
    Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const side = yield* connect(TestDatabase.layer)
        return yield* body({ a: side, b: side })
      })) as Effect.Effect<never>
    )
}

describeContract(nodeFileHarness)
describeContract(memoryHarness)
