/**
 * Node SQLite database layer.
 *
 * Backend pattern:
 * `reference/effect/packages/sql/sqlite-node/src/SqliteClient.ts`.
 * The browser counterpart is tracked against Effect's
 * `sqlite-wasm/src/OpfsWorker.ts`.
 *
 * @since 0.1.0
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Database from "../Database.ts"
import type * as WriteRetry from "../internal/WriteRetry.ts"

/**
 * Configuration for a Node SQLite database.
 *
 * @category models
 * @since 0.1.0
 */
export interface NodeDatabaseOptions extends WriteRetry.WriteRetryOptions {
  /** SQLite database filename. */
  readonly filename: string
  /** Additional driver configuration. WAL remains enabled unless explicitly disabled. */
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}

/**
 * Provides the node:sqlite client and the thin Database service. WAL is enabled
 * by the underlying client by default.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: NodeDatabaseOptions): Layer.Layer<Database.Database> => {
  const sqlite = SqliteClient.layer({
    ...options.sqlite,
    filename: options.filename
  })
  const database = Layer.effect(
    Database.Database,
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => Database.make(sql, options))
  )
  return Layer.provide(database, sqlite)
}
