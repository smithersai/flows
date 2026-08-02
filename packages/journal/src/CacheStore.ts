/**
 * Durable content-addressed step result storage.
 *
 * This store receives already-computed digests and recorded results. It does
 * not inspect step layers, capabilities, or result metadata.
 *
 * Governing designs: `docs/specs/Concepts/Step Keys.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { Database, DatabaseError } from "@smithers/database/Database"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlError from "effect/unstable/sql/SqlError"

/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export const CacheStoreErrorCode = Schema.Literals([
  "invalid_cache",
  "constraint",
  "decode_failed",
  "persistence_failed",
  "unknown"
])

/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheStoreErrorCode = typeof CacheStoreErrorCode.Type

/**
 * Error raised by cache persistence operations.
 *
 * @category errors
 * @since 0.1.0
 */
export class CacheStoreError extends Schema.TaggedErrorClass<CacheStoreError>()(
  "flows/journal/CacheStoreError",
  {
    code: CacheStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * The durable data recorded for a cache key.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheEntry {
  readonly keyDigest: string
  readonly result: unknown
  readonly meta: unknown
  readonly createdAtMs: number
  readonly recordedRunId: string
  readonly recordedEventSeq: number
}

/**
 * Fencing predicate for an eviction.
 *
 * @category models
 * @since 0.1.0
 */
export type EvictOptions = {
  /**
   * Deletes the row only while it is still the one recorded by this
   * `(runId, eventSeq)` pair. Omitting the predicate deletes unconditionally.
   */
  readonly ifRecordedBy?: {
    readonly runId: string
    readonly eventSeq: number
  }
}

/**
 * Result of recording an entry under a content digest.
 *
 * @category models
 * @since 0.1.0
 */
export type PutResult =
  | { readonly _tag: "Inserted" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict" }

/**
 * Content-addressed cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly get: (keyDigest: string) => Effect.Effect<Option.Option<CacheEntry>, CacheStoreError>
  readonly put: (entry: CacheEntry) => Effect.Effect<PutResult, CacheStoreError>
  /**
   * Removes the row for `keyDigest`, returning whether a row was deleted.
   * With `ifRecordedBy` the delete is a single fenced compare-and-swap, so a
   * fresher row landed by a foreign process is never deleted with the poison
   * (issue #119).
   */
  readonly evict: (
    keyDigest: string,
    options?: EvictOptions
  ) => Effect.Effect<boolean, CacheStoreError>
}

/**
 * Service tag for content-addressed recorded step results.
 *
 * @category services
 * @since 0.1.0
 */
export class CacheStore extends Context.Service<CacheStore, Service>()("flows/journal/CacheStore") {}

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const CacheRow = Schema.Struct({
  key_digest: Schema.NonEmptyString,
  result_json: Schema.String,
  meta_json: Schema.String,
  created_at_ms: NonNegativeSafeInt,
  recorded_run_id: Schema.NonEmptyString,
  recorded_event_seq: NonNegativeSafeInt
})

type CacheRow = typeof CacheRow.Type

const CacheEntryInput = Schema.Struct({
  keyDigest: Schema.NonEmptyString,
  result: Schema.Unknown,
  meta: Schema.Unknown,
  createdAtMs: NonNegativeSafeInt,
  recordedRunId: Schema.NonEmptyString,
  recordedEventSeq: NonNegativeSafeInt
})

const error = (code: CacheStoreErrorCode, message: string, cause?: unknown): CacheStoreError =>
  new CacheStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

const encode = (value: unknown, field: string): Effect.Effect<string, CacheStoreError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => error("invalid_cache", `${field} must be JSON-serializable`, cause)
  }).pipe(
    Effect.flatMap((encoded) =>
      encoded === undefined
        ? Effect.fail(error("invalid_cache", `${field} must be JSON-serializable`))
        : Effect.succeed(encoded)
    )
  )

const decode = (value: string, field: string): Effect.Effect<unknown, CacheStoreError> =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => error("decode_failed", `could not decode ${field}`, cause)
  })

const validateKey = (keyDigest: string): Effect.Effect<void, CacheStoreError> =>
  keyDigest.length > 0
    ? Effect.void
    : Effect.fail(error("invalid_cache", "keyDigest must not be empty"))

const validateEntry = (entry: CacheEntry): Effect.Effect<void, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheEntryInput)(entry).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => error("invalid_cache", "cache entry violates the persistence contract", cause))
  )

const mapPersistenceError = (cause: unknown): CacheStoreError => {
  if (Schema.is(CacheStoreError)(cause)) {
    return cause
  }
  const constraint = Schema.is(DatabaseError)(cause)
    ? cause.code === "constraint"
    : SqlError.isSqlError(cause) &&
      (cause.reason instanceof SqlError.ConstraintError || cause.reason instanceof SqlError.UniqueViolation)
  return error(
    constraint ? "constraint" : "persistence_failed",
    "cache persistence failed",
    cause
  )
}

const decodeRow = (input: unknown): Effect.Effect<CacheEntry, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheRow)(input).pipe(
    Effect.mapError((cause) => error("decode_failed", "could not decode flows_step_cache row", cause)),
    Effect.flatMap((row) =>
      Effect.all({ result: decode(row.result_json, "result_json"), meta: decode(row.meta_json, "meta_json") }).pipe(
        Effect.map(({ result, meta }) => ({
          keyDigest: row.key_digest,
          result,
          meta,
          createdAtMs: row.created_at_ms,
          recordedRunId: row.recorded_run_id,
          recordedEventSeq: row.recorded_event_seq
        }))
      )
    )
  )

/**
 * Builds the SQL-backed cache store.
 *
 * A cache hit is returned as the step's result, so cached values are
 * executable state and are persisted verbatim; rewriting them here would
 * serve a different value than the one the step produced (issue #72).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service, never, Database> = Effect.gen(function*() {
  const database = yield* Database
  const { sql } = database

  const get: Service["get"] = Effect.fn("CacheStore.get")((keyDigest) =>
    Effect.gen(function*() {
      yield* validateKey(keyDigest)
      const rows = yield* sql<Record<string, unknown>>`
        SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
        FROM flows_step_cache WHERE key_digest = ${keyDigest}
      `.pipe(Effect.mapError(mapPersistenceError))
      return rows.length === 0 ? Option.none() : yield* Effect.map(decodeRow(rows[0]!), Option.some)
    })
  )

  const put: Service["put"] = Effect.fn("CacheStore.put")((entry) =>
    Effect.gen(function*() {
      yield* validateEntry(entry)
      const result = yield* encode(entry.result, "result")
      const meta = yield* encode(entry.meta, "meta")
      return yield* database.write(
        Effect.gen(function*() {
          const inserted = yield* sql`
            INSERT INTO flows_step_cache (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          if ((inserted as { readonly changes: number }).changes > 0) {
            return { _tag: "Inserted" } as const
          }
          const rows = yield* sql<Pick<CacheRow, "result_json">>`
            SELECT result_json FROM flows_step_cache WHERE key_digest = ${entry.keyDigest}
          `.pipe(Effect.mapError(mapPersistenceError))
          /* v8 ignore next -- the conflicting row is read in the same serialized write transaction */
          if (rows.length === 0) {
            return yield* Effect.fail(error("unknown", "cache entry disappeared during put"))
          }
          return rows[0]!.result_json === result
            ? { _tag: "ExistingSame" } as const
            : { _tag: "Conflict" } as const
        })
      ).pipe(Effect.mapError(mapPersistenceError))
    })
  )

  const evict: Service["evict"] = Effect.fn("CacheStore.evict")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* validateKey(keyDigest)
      // The provenance predicate rides in the DELETE itself (issue #119):
      // a read-then-delete leaves a window in which another *process* records
      // a fresh row under the same key, and the unconditional delete would
      // drop it. Temporal fences its mutable-state writes the same way — the
      // guard is part of the write, never a prior read.
      const fenced = options?.ifRecordedBy
      const deleted = yield* database.write(
        fenced === undefined
          ? sql`DELETE FROM flows_step_cache WHERE key_digest = ${keyDigest}`.raw
          : sql`
            DELETE FROM flows_step_cache
            WHERE key_digest = ${keyDigest}
              AND recorded_run_id = ${fenced.runId}
              AND recorded_event_seq = ${fenced.eventSeq}
          `.raw
      ).pipe(Effect.mapError(mapPersistenceError))
      return (deleted as { readonly changes: number }).changes > 0
    })
  )

  return { get, put, evict }
})

/**
 * Creates a cache store from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) => Effect.fail(error("unknown", `${method} is unavailable`))
  return {
    get: Effect.fn("CacheStore.get")(() => unavailable("get")),
    put: Effect.fn("CacheStore.put")(() => unavailable("put")),
    evict: Effect.fn("CacheStore.evict")(() => unavailable("evict")),
    ...overrides
  }
}

/**
 * Provides a no-op cache store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<CacheStore> =>
  Layer.succeed(CacheStore)(makeNoop(overrides))

/**
 * Provides the SQL-backed cache store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<CacheStore, never, Database> = Layer.effect(CacheStore)(make)
