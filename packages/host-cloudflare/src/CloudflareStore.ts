/** Durable Object SQLite store binding. @since 0.1.0 */
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import * as Database from "@flows/database/Database"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Provides `Database` from one Durable Object's SQLite storage. The Effect
 * sqlite-do client invokes `storage.transaction` for `withTransaction`; this
 * is intentionally not the D1 client, whose API cannot provide this guarantee.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (storage: DurableObjectStorage): Layer.Layer<Database.Database> =>
  Layer.provide(
    Layer.effect(Database.Database, Effect.map(SqlClient.SqlClient, Database.make)),
    SqliteClient.layer({ storage })
  ) as Layer.Layer<Database.Database>
