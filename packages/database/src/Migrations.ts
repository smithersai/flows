/**
 * Composition of per-package SQL migration sets over one migrations table.
 *
 * Every storage package above `@smthrs/database` owns its own tables and
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
 * Blocks reintroduce a second way to skip one: `Migrator` decides what to run
 * from a single high-water mark, so a set whose id lands at or below the
 * highest id the database already applied would be assumed done and never run.
 * The loader applies those missing lower-block migrations itself inside the
 * migrator transaction, the same way it has always handled global id zero.
 *
 * {@link run} wraps the whole migrator pass in the same transient-lock retry
 * the durable writer uses, so concurrent processes migrating one database
 * serialize instead of failing on the peer's `BEGIN IMMEDIATE` lock.
 *
 * Derived contract: `docs/specs/Concepts/Journal Split.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as WriteRetry from "./internal/WriteRetry.ts"

/**
 * The single table every flows package records its applied migrations in.
 *
 * @category constants
 * @since 0.1.0
 * @slop
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
 * @slop
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
 * @slop
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
 * The migration with global id zero, which `Migrator` can never run: it
 * treats a fresh database as having high-water mark zero, so id zero always
 * sits at or below the mark. The loader applies it itself instead.
 *
 * @private
 */
interface ZeroMigration {
  readonly name: string
  readonly migration: Effect.Effect<void, unknown, SqlClient.SqlClient>
}

interface ManualMigration extends ZeroMigration {
  readonly id: number
}

/**
 * Applies the id-zero migration and records it in the migrations table.
 *
 * The loader runs inside the migrator's transaction, so this application
 * commits and rolls back with the rest of the run. Failures follow the
 * migrator's own convention for a failed migration: they die with a `Failed`
 * `MigrationError` that keeps the cause, so a transient lock conflict stays
 * classifiable by {@link run}'s retry while a real failure surfaces loudly.
 *
 * @private
 */
const applyZero = (zero: ZeroMigration) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* zero.migration
    yield* sql`INSERT INTO ${sql(table)} ${sql.insert([{ migration_id: 0, name: zero.name }])}`.withoutTransform
  }).pipe(
    Effect.catch((cause) =>
      Effect.die(new Migrator.MigrationError({ cause, kind: "Failed", message: `Migration "0_${zero.name}" failed` }))
    )
  )

/**
 * Applies migrations the underlying high-water-mark migrator would otherwise
 * skip.
 *
 * @private
 */
const applyMissingBelowHighWater = (
  resolved: ReadonlyArray<Migrator.ResolvedMigration>,
  manual: ReadonlyMap<number, ManualMigration>,
  applied: Set<number>,
  onApplied: (entry: readonly [id: number, name: string]) => Effect.Effect<void>
): Effect.Effect<ReadonlyArray<Migrator.ResolvedMigration>, Migrator.MigrationError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const highWater = Math.max(0, ...applied)
    for (const [id, name] of resolved) {
      if (id <= highWater && !applied.has(id)) {
        const migration = manual.get(id)!
        yield* Effect.gen(function*() {
          yield* migration.migration
          yield* sql`INSERT INTO ${sql(table)} ${sql.insert([{ migration_id: id, name }])}`.withoutTransform
          yield* onApplied([id, name])
          applied.add(id)
        }).pipe(
          Effect.catch((cause) =>
            Effect.die(
              new Migrator.MigrationError({ cause, kind: "Failed", message: `Migration "${id}_${name}" failed` })
            )
          )
        )
      }
    }
    return resolved
  })

/**
 * Applies the id-zero migration when the database is fresh, then backfills
 * lower ids the underlying high-water-mark migrator would skip. Id zero exists
 * only on a fresh database — on any other database it is already applied — so
 * applying it here, inside the migrator's transaction, closes the one case the
 * migrator's high-water mark cannot express.
 *
 * @private
 */
const finish = (
  resolved: ReadonlyArray<Migrator.ResolvedMigration>,
  manual: ReadonlyMap<number, ManualMigration>,
  zero: ZeroMigration | undefined,
  onApplied: (entry: readonly [id: number, name: string]) => Effect.Effect<void>
) =>
  Effect.gen(function*() {
    const applied = yield* appliedIds
    if (applied.size === 0 && zero !== undefined) {
      yield* applyZero(zero)
      yield* onApplied([0, zero.name])
      applied.add(0)
    }
    const afterManual = yield* applyMissingBelowHighWater(resolved, manual, applied, onApplied)
    return afterManual
  })

/** @private */
const loaderWith = (
  sets: ReadonlyArray<MigrationSet>,
  onZeroApplied: (entry: readonly [id: number, name: string]) => Effect.Effect<void>
): Migrator.Loader<SqlClient.SqlClient> =>
  Effect.suspend(() => {
    const namespaces = new Set<string>()
    const offsets = new Set<number>()
    const ids = new Map<number, string>()
    const resolved: Array<Migrator.ResolvedMigration> = []
    const manual = new Map<number, ManualMigration>()
    let zero: ZeroMigration | undefined

    for (const set of sets) {
      if (namespaces.has(set.namespace)) {
        return Effect.fail(fail(`Duplicate migration namespace: ${set.namespace}`))
      }
      namespaces.add(set.namespace)
      // A negative offset can still produce a positive migration id, and a
      // fractional one forwards a fractional id to the database, so both are
      // bad migration state the loader rejects rather than shapes SQL later
      // chokes on.
      if (!Number.isInteger(set.idOffset) || set.idOffset < 0) {
        return Effect.fail(fail(
          `Invalid migration id offset ${set.idOffset} for namespace ${set.namespace}: ` +
            `an id offset must be a non-negative integer`
        ))
      }
      if (offsets.has(set.idOffset)) {
        return Effect.fail(fail(`Duplicate migration id offset ${set.idOffset} for namespace ${set.namespace}`))
      }
      offsets.add(set.idOffset)

      for (const [key, migration] of Object.entries(set.migrations)) {
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
        if (id === 0) {
          zero = { migration, name: `${set.namespace}_${match[2]}` }
        }
        manual.set(id, { id, migration, name: `${set.namespace}_${match[2]}` })
        resolved.push([id, `${set.namespace}_${match[2]}`, Effect.succeed(migration)])
      }
    }

    return finish(resolved.sort(migrationOrder), manual, zero, onZeroApplied)
  })

/**
 * Builds a `Migrator` loader from namespaced package migration sets, in the
 * order given.
 *
 * On a fresh database the loader applies a global id-zero migration itself,
 * inside the migrator's transaction, because the migrator's high-water mark
 * starts at zero and would silently skip it. A caller wiring the loader into
 * its own `Migrator` therefore gets id zero applied, but not reported in the
 * migrator's completed list; {@link run} reports it.
 *
 * @category loaders
 * @since 0.1.0
 * @slop
 */
export const loader = (sets: ReadonlyArray<MigrationSet>): Migrator.Loader<SqlClient.SqlClient> =>
  loaderWith(sets, () => Effect.void)

/**
 * Runs every migration in the given sets that has not been applied yet.
 *
 * The whole migrator pass — `BEGIN IMMEDIATE`, the loader, and the pending
 * migrations — retries on the transient lock vocabulary `WriteRetry`
 * recognises, so two connections migrating one SQLite file serialize: the
 * loser of the write-lock race replays after the winner commits and finds
 * the migrations applied, instead of surfacing `SQLITE_BUSY` or applying
 * them twice.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const run = (
  sets: ReadonlyArray<MigrationSet>
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function*() {
    const manuallyApplied = yield* Ref.make<ReadonlyArray<readonly [id: number, name: string]>>([])
    const completed = yield* WriteRetry.withWriteRetry(
      Migrator.make({})({
        // Reset before each attempt: a retry that finds a peer already applied
        // a manual migration must not keep reporting the rolled-back application.
        loader: Ref.set(manuallyApplied, []).pipe(
          Effect.andThen(loaderWith(sets, (entry) => Ref.update(manuallyApplied, (entries) => [...entries, entry])))
        ),
        table
      })
    )
    const manual = yield* Ref.get(manuallyApplied)
    return [...manual, ...completed]
  })

/**
 * Layer that runs the given migration sets before exposing the database to
 * durable services.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  sets: ReadonlyArray<MigrationSet>
): Layer.Layer<never, Migrator.MigrationError | SqlError, SqlClient.SqlClient> => Layer.effectDiscard(run(sets))
