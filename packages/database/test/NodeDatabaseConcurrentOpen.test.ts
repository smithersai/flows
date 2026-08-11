import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), "flows-db-open-")), "open.sqlite")

/**
 * Creates the database in rollback journal mode, so opening it still has to
 * perform the WAL conversion — the step that needs an exclusive lock.
 */
const seedRollbackMode = (filename: string): void => {
  const db = new DatabaseSync(filename)
  try {
    db.exec("PRAGMA journal_mode = DELETE")
    db.exec("CREATE TABLE seeded (id INTEGER PRIMARY KEY)")
  } finally {
    db.close()
  }
}

/** Takes the file's write lock, as a peer process mid-transaction would hold it. */
const holdWriteLock = (filename: string): { readonly release: () => void } => {
  const db = new DatabaseSync(filename)
  db.exec("PRAGMA busy_timeout = 0")
  db.exec("BEGIN EXCLUSIVE")
  return {
    release: () => {
      db.exec("COMMIT")
      db.close()
    }
  }
}

describe("NodeDatabase concurrent open", () => {
  it("waits for a peer holding the file lock instead of failing the open", async () => {
    const filename = tempFile()
    seedRollbackMode(filename)
    const lock = holdWriteLock(filename)
    // Release only after the open is already under way, so the open must
    // genuinely wait on the lock rather than never observing it.
    const timer = setTimeout(() => lock.release(), 150)

    try {
      const rows = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const context = yield* Layer.build(
            NodeDatabase.layer({ filename }) as unknown as Layer.Layer<never>
          )
          const sql = yield* (Effect.service(SqlClient.SqlClient).pipe(
            Effect.provide(context as never)
          ) as Effect.Effect<SqlClient.SqlClient>)
          return yield* sql<{ readonly id: number }>`SELECT id FROM seeded`
        }))
      )
      expect(rows).toEqual([])
    } finally {
      clearTimeout(timer)
    }
  })

  it("does not retry an open failure that is not a lock", async () => {
    // A directory is not a database: the open fails with something other than
    // a lock, so it must surface immediately rather than burn the retry budget.
    const directory = mkdtempSync(join(tmpdir(), "flows-db-open-"))
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(NodeDatabase.layer({ filename: directory }) as unknown as Layer.Layer<never>))
    )
    expect(exit._tag).toBe("Failure")
  })

  it.each([
    { label: "an in-memory database", options: { filename: ":memory:" } },
    { label: "a shared in-memory database", options: { filename: "file::memory:?cache=shared" } },
    { label: "WAL explicitly disabled", options: { filename: tempFile(), sqlite: { disableWAL: true } } }
  ])("opens $label unaffected by the retry", async ({ options }) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(NodeDatabase.layer(options) as unknown as Layer.Layer<never>))
    )
    expect(exit._tag).toBe("Success")
  })

  it("leaves the file in WAL, so a later open needs no mode change", async () => {
    const filename = tempFile()
    seedRollbackMode(filename)

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(NodeDatabase.layer({ filename }) as unknown as Layer.Layer<never>)
      )
    )

    const db = new DatabaseSync(filename)
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    } finally {
      db.close()
    }
  })
})
