/**
 * Server-only Vercel database binding.
 *
 * The edge Host root does not export this module. A deployed Vercel function
 * supplies a PostgreSQL `SqlClient` (typically from `@effect/sql-pg`) and this
 * layer composes it with the public `@flows/database` transaction service.
 *
 * @since 0.1.0
 */
import { Database } from "@flows/database"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** A supplied PostgreSQL SQL client, created by the server runtime. @category models @since 0.1.0 */
export interface Options {
  readonly sql: SqlClient.SqlClient
}

/** Composes the supplied PostgreSQL client with `Database.make`. @category layers @since 0.1.0 */
export const layer = (options: Options): Layer.Layer<Database.Database> =>
  Layer.succeed(Database.Database, Database.make(options.sql))

/** Builds the Database service from an Effect SQL client in the environment. @category layers @since 0.1.0 */
export const layerFromService: Layer.Layer<Database.Database, never, SqlClient.SqlClient> = Layer.effect(
  Database.Database,
  Effect.map(SqlClient.SqlClient, (sql) => Database.make(sql))
)
