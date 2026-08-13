/**
 * Composition of per-package SQL migration sets over one migrations table.
 *
 * Every storage package above `@smthrs/database-next` owns its own tables and
 * therefore its own migrations, but they all migrate ONE database and record
 * their progress in ONE `flows_migrations` table. Effect's `Migrator` keys a
 * migration by a numeric id, so two packages that both ship an `0001_initial`
 * would either collide or — worse, if they were merged as a plain record —
 * silently shadow one another.
 *
 * A {@link MigrationSet} closes that hole by making the namespace part of the
 * identity: the package's `namespace` prefixes every migration name and its
 * `idOffset` reserves a disjoint block of migration ids. {@link loader}
 * rejects duplicate namespaces, duplicate offsets, and any id collision the
 * offsets failed to prevent, so a mis-declared package fails the migration
 * rather than skipping a table.
 *
 * Blocks reintroduce a second way to skip one, which the loader also rejects:
 * `Migrator` decides what to run from a single high-water mark, so a set whose
 * id lands at or below the highest id the database already applied would be
 * assumed done and never run. See `rejectSkipped`.
 *
 * Derived contract: `docs/specs/Concepts/Journal Split.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * The single table every flows package records its applied migrations in.
 *
 * @category constants
 * @since 0.1.0
 */
export const table = "flows_migrations"

/**
 * One package's migrations, namespaced so they cannot collide with another
 * package's.
 *
 * `migrations` is keyed the way `Migrator.fromRecord` keys it — `<id>_<name>`,
 * with the id local to the package — and `idOffset` lifts those local ids into
 * the block this package owns. Offsets are spaced by {@link idBlock}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MigrationSet {
  readonly namespace: string
  readonly idOffset: number
  readonly migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
}

/**
 * The spacing between the migration id blocks packages reserve with
 * `MigrationSet.idOffset`. A package may ship this many migrations before it
 * would run into its neighbour, and {@link loader} fails loudly if one ever
 * does.
 *
 * @category constants
 * @since 0.1.0
 */
export const idBlock = 1000

/**
 * Ids are unique by the time this runs — {@link loader} rejects collisions
 * first — so plain subtraction is a total order, not a partial one.
 *
 * @private
 */
const migrationOrder = (left: Migrator.ResolvedMigration, right: Migrator.ResolvedMigration) => left[0] - right[0]

/** @private */
const fail = (message: string) => new Migrator.MigrationError({ kind: "BadState", message })

/**
 * The migration ids the database has already recorded.
 *
 * {@link loader} runs inside the migrator's transaction, after it has ensured
 * the table exists, so this read is safe there. Called on its own against a
 * database that was never migrated it fails as a `BadState`, which is what a
 * caller wiring the loader by hand wants to hear.
 *
 * @private
 */
const appliedIds = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly migration_id: number }>`SELECT migration_id FROM ${sql(table)}`.withoutTransform
  return new Set(rows.map((row) => row.migration_id))
}).pipe(
  Effect.mapError((cause) =>
    new Migrator.MigrationError({ kind: "BadState", cause, message: `Could not read ${table}` })
  )
)

/**
 * Rejects a set whose migration would be silently skipped.
 *
 * `Migrator` records applied migrations but decides what to run from a single
 * high-water mark: anything with an id at or below the highest applied id is
 * assumed done. Namespaced id blocks make that assumption false — a database
 * migrated with only the `2000` block would treat the `0` and `1000` blocks as
 * already applied and never create their tables, and a package that adds a
 * second migration inside a block below the mark would never run it. Neither
 * case can be repaired by running the migration again, so the composition
 * fails here instead of returning a set the migrator would quietly drop.
 *
 * @private
 */
const rejectSkipped = (resolved: ReadonlyArray<Migrator.ResolvedMigration>) =>
  Effect.flatMap(appliedIds, (applied) => {
    const highWater = Math.max(0, ...applied)
    for (const [id, name] of resolved) {
      if (id <= highWater && !applied.has(id)) {
        return Effect.fail(fail(
          `Migration ${id}_${name} would be skipped: the database has already applied migration id ${highWater}, ` +
            `and the migrator only runs ids above the highest applied one. Compose every package's migration set ` +
            `from the first migration onwards, and give a new migration an id above ${highWater}.`
        ))
      }
    }
    return Effect.succeed(resolved)
  })

/**
 * Builds a `Migrator` loader from namespaced package migration sets, in the
 * order given.
 *
 * @category loaders
 * @since 0.1.0
 */
export const loader = (sets: ReadonlyArray<MigrationSet>): Migrator.Loader<SqlClient.SqlClient> =>
  Effect.suspend(() => {
    const namespaces = new Set<string>()
    const offsets = new Set<number>()
    const ids = new Map<number, string>()
    const resolved: Array<Migrator.ResolvedMigration> = []

    for (const set of sets) {
      if (namespaces.has(set.namespace)) {
        return Effect.fail(fail(`Duplicate migration namespace: ${set.namespace}`))
      }
      namespaces.add(set.namespace)
      if (offsets.has(set.idOffset)) {
        return Effect.fail(fail(`Duplicate migration id offset ${set.idOffset} for namespace ${set.namespace}`))
      }
      offsets.add(set.idOffset)

      for (const key of Object.keys(set.migrations)) {
        const match = key.match(/^(\d+)_(.+)$/)
        if (match === null) {
          return Effect.fail(fail(`Malformed migration key "${key}" in namespace ${set.namespace}`))
        }
        const id = set.idOffset + Number(match[1])
        const owner = ids.get(id)
        if (owner !== undefined) {
          return Effect.fail(fail(`Migration id ${id} claimed by both ${owner} and ${set.namespace}`))
        }
        ids.set(id, set.namespace)
        resolved.push([id, `${set.namespace}_${match[2]}`, Effect.succeed(set.migrations[key])])
      }
    }

    return rejectSkipped(resolved.sort(migrationOrder))
  })

/**
 * Runs every migration in the given sets that has not been applied yet.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = (
  sets: ReadonlyArray<MigrationSet>
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> => Migrator.make({})({ loader: loader(sets), table })

/**
 * Layer that runs the given migration sets before exposing the database to
 * durable services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  sets: ReadonlyArray<MigrationSet>
): Layer.Layer<never, Migrator.MigrationError | SqlError, SqlClient.SqlClient> => Layer.effectDiscard(run(sets))
