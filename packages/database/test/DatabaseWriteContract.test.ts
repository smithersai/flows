import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Database from "../src/Database.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"

/** Builds one `Database` service and keeps its connection open for the scope. */
const connect = (layer: Layer.Layer<Database.Database>) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(layer as unknown as Layer.Layer<never>)
    return yield* (Effect.service(Database.Database).pipe(
      Effect.provide(context as never)
    ) as Effect.Effect<Database.DatabaseService>)
  })

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
        const a = yield* connect(NodeDatabase.layer({ filename }))
        const b = yield* connect(NodeDatabase.layer({ filename }))
        return yield* body({ a, b })
      }))
    )
  }
}

/**
 * The in-memory path used by every other suite. `:memory:` is private to a
 * connection, so both handles are the same service and serialization comes
 * from the client's in-process transaction mutex rather than the database —
 * a weaker mechanism that must still satisfy the same contract.
 */
const memoryHarness: Harness = {
  label: "TestDatabase, one shared in-memory connection",
  run: (body) =>
    Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const database = yield* connect(TestDatabase.layer)
        return yield* body({ a: database, b: database })
      }))
    )
}

describeContract(nodeFileHarness)
describeContract(memoryHarness)
