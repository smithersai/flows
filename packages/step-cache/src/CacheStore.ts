/**
 * Durable content-addressed step result storage.
 *
 * This store receives already-computed digests and recorded results. It does
 * not inspect step layers, capabilities, or result metadata.
 *
 * The two tables it owns are rebuildable materializations of journal events:
 * every row change appends a `flows.cache.*` event in the same
 * `DurableWriter` transaction, and `Fold` rebuilds the tables from those
 * events. See `docs/specs/Concepts/Step Cache Fold.md`.
 *
 * Governing designs: `docs/specs/Concepts/Step Keys.md`,
 * `docs/specs/Concepts/Trust Granularity.md`, and
 * `docs/specs/Concepts/Journal Consensus.md`.
 *
 * @since 0.1.0
 */
import { Canonical } from "@smthrs/canonical/Canonical"
import { affectedRows, DatabaseError } from "@smthrs/database/DurableWriter"
import * as Journal from "@smthrs/journal/Journal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as CacheStoreMetrics from "./CacheStoreMetrics.ts"
import * as CacheEvents from "./internal/CacheEvents.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

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
 * The identity string equals the defining module path, like every other
 * identity in this repository.
 *
 * @category errors
 * @since 0.1.0
 */
export class CacheStoreError extends Schema.TaggedError<CacheStoreError>()(
  "@smthrs/step-cache/CacheStoreError",
  {
    code: CacheStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * The durable data recorded for a cache key. Also the payload of the
 * `flows.cache.recorded` event a `put` appends, which is what makes the
 * materialized row rebuildable byte-for-byte.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CacheEntry = CacheEvents.Entry

/**
 * The durable data recorded for a cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheEntry = typeof CacheEntry.Type

/**
 * Provenance selector for a lookup.
 *
 * @category models
 * @since 0.1.0
 */
export type GetOptions = {
  /**
   * Prefers the entry as it was recorded by this `(runId, eventSeq)` pair —
   * the append-only `flows_step_cache_recorded` ledger row a `put` lands
   * beside the head — falling back to the mutable head when no recorded
   * version under that provenance exists. Replay reads through this fence so
   * an old frame's projection stays a function of durable state: evicting or
   * replacing the head never changes what that event recorded.
   */
  readonly recordedBy?: {
    readonly runId: string
    readonly eventSeq: number
  }
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
  /**
   * The entry under `keyDigest`: the mutable head by default, or — with
   * `recordedBy` — the durable recorded version that exact event landed,
   * falling back to the head when the ledger holds none.
   */
  readonly get: (
    keyDigest: string,
    options?: GetOptions
  ) => Effect.Effect<Option.Option<CacheEntry>, CacheStoreError>
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
 * The identity string equals the defining module path, like every other
 * service identity in this repository. The pre-split `flows/journal/CacheStore`
 * identity from `docs/specs/Concepts/Journal Split.md` was retired pre-release,
 * while no persisted journal or step-key digest named it.
 *
 * @category services
 * @since 0.1.0
 */
export class CacheStore extends Context.Service<CacheStore, Service>()("@smthrs/step-cache/CacheStore") {}

const CacheRow = Schema.Struct({
  key_digest: Schema.NonEmptyString,
  result_json: Schema.String,
  meta_json: Schema.String,
  created_at_ms: NonNegativeSafeInt,
  recorded_run_id: Schema.NonEmptyString,
  recorded_event_seq: NonNegativeSafeInt
})

type CacheRow = typeof CacheRow.Type

const error = (code: CacheStoreErrorCode, message: string, cause?: unknown): CacheStoreError =>
  new CacheStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

/**
 * Encodes a stored value as RFC 8785 canonical JSON.
 *
 * `put` decides `ExistingSame` versus `Conflict` by comparing `result_json`
 * text. `JSON.stringify` output depends on key insertion order, so two
 * structurally equal results built in different orders compared unequal, and
 * `ActionPersistence` routes `Conflict` to the `Inconsistency` receiver whose
 * core default verdict is `fail` — the run failed with `CacheConflictDetected`
 * naming a divergence that did not exist. Canonicalizing on the way in makes
 * the text comparison a structural one, which is what `@smthrs/canonical`
 * exists for.
 *
 * `RemoteCacheStore.put` runs the same check before serializing an entry onto
 * the wire, so a value with no JSON form is refused identically by both tiers.
 * `Fold.rebuild` materializes rows through it, so a rebuilt row is byte-equal
 * to the row the live write landed.
 *
 * @since 0.1.0
 * @private
 */
export const encodeCanonical = (value: unknown, field: string): Effect.Effect<string, CacheStoreError> =>
  Schema.decodeUnknownEffect(Canonical)(value).pipe(
    Effect.mapError((cause) => error("invalid_cache", `${field} must have a canonical JSON form`, cause))
  )

const decode = (value: string, field: string): Effect.Effect<unknown, CacheStoreError> =>
  Schema.decodeUnknownEffect(UnknownFromJsonString)(value).pipe(
    Effect.mapError((cause) => error("decode_failed", `could not decode ${field}`, cause))
  )

/**
 * Refuses an empty key digest before any statement or request is issued.
 *
 * @since 0.1.0
 * @private
 */
export const validateKey = (keyDigest: string): Effect.Effect<void, CacheStoreError> =>
  keyDigest.length > 0
    ? Effect.void
    : Effect.fail(error("invalid_cache", "keyDigest must not be empty"))

/** The shape a caller-supplied eviction fence must decode into. */
const EvictFence = Schema.Struct({
  runId: Schema.NonEmptyString,
  eventSeq: NonNegativeSafeInt
})

/**
 * Refuses a malformed eviction fence before any statement or request is
 * issued. A fence naming an empty run or a sequence number no journal can
 * record is a compare-and-swap no row could ever satisfy; running it anyway
 * would misreport the caller's mistake as an ordinary "nothing matched".
 *
 * @since 0.1.0
 * @private
 */
export const validateFence = (
  fence: EvictOptions["ifRecordedBy"]
): Effect.Effect<void, CacheStoreError> =>
  fence === undefined
    ? Effect.void
    : Schema.decodeUnknownEffect(EvictFence)(fence).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => error("invalid_cache", "eviction fence violates the persistence contract", cause))
    )

const validateEntry = (entry: CacheEntry): Effect.Effect<void, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheEntry)(entry).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => error("invalid_cache", "cache entry violates the persistence contract", cause))
  )

const mapPersistenceError = (cause: unknown): CacheStoreError => {
  if (Schema.is(CacheStoreError)(cause)) {
    return cause
  }
  // `Journal.transact` wraps a failed cache transaction in its own error with
  // the database failure as `cause`; classify from the underlying failure so
  // a constraint keeps reporting `constraint` through the fold.
  if (Schema.is(Journal.JournalError)(cause) && cause.cause !== undefined) {
    return mapPersistenceError(cause.cause)
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
 * Every row change commits with the `flows.cache.*` event describing it in
 * one `Journal.transact` transaction, so either the row and its event are
 * both durable or neither is. Cache events are unfenced — admission is
 * content-address first-writer-wins, not run ownership — and a repeat that
 * changes nothing appends nothing, which is the fold's idempotency
 * (`docs/specs/Concepts/Step Cache Fold.md`).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service, never, Journal.Journal | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const journal = yield* Journal.Journal

  const get: Service["get"] = Effect.fn("CacheStore.get")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ keyDigest })
      yield* validateKey(keyDigest)
      const recordedBy = options?.recordedBy
      if (recordedBy !== undefined) {
        // The ledger row is the durable evidence a replay of that exact event
        // must read; the head is only the fallback for entries recorded under
        // another provenance (a fork sharing the parent's keys, a shared-tier
        // write-back, a pre-ledger row).
        const recorded = yield* sql<Record<string, unknown>>`
          SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          FROM flows_step_cache_recorded
          WHERE key_digest = ${keyDigest}
            AND recorded_run_id = ${recordedBy.runId}
            AND recorded_event_seq = ${recordedBy.eventSeq}
        `.pipe(Effect.mapError(mapPersistenceError))
        if (recorded.length > 0) {
          const entry = yield* decodeRow(recorded[0]!)
          yield* Metric.update(CacheStoreMetrics.hit, 1)
          return Option.some(entry)
        }
      }
      const rows = yield* sql<Record<string, unknown>>`
        SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
        FROM flows_step_cache WHERE key_digest = ${keyDigest}
      `.pipe(Effect.mapError(mapPersistenceError))
      if (rows.length === 0) {
        yield* Metric.update(CacheStoreMetrics.miss, 1)
        return Option.none()
      }
      const entry = yield* decodeRow(rows[0]!)
      yield* Metric.update(CacheStoreMetrics.hit, 1)
      return Option.some(entry)
    })
  )

  const put: Service["put"] = Effect.fn("CacheStore.put")((entry) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ keyDigest: entry.keyDigest })
      yield* validateEntry(entry)
      const result = yield* encodeCanonical(entry.result, "result")
      const meta = yield* encodeCanonical(entry.meta, "meta")
      return yield* journal.transact(
        Effect.gen(function*() {
          // The recorded ledger lands first and unconditionally: whatever the
          // head decides — first write, duplicate, or conflict — this event
          // durably recorded these bytes, and a later replay naming exactly
          // this provenance must read them back. First writer wins per
          // provenance key; nothing but journal compaction deletes a ledger
          // row, and the fold itself never does.
          const ledger = yield* sql`
            INSERT INTO flows_step_cache_recorded (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest, recorded_run_id, recorded_event_seq) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          const ledgerInserted = (yield* affectedRows(ledger)) > 0
          const inserted = yield* sql`
            INSERT INTO flows_step_cache (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          const headInserted = (yield* affectedRows(inserted)) > 0
          const outcome = yield* Effect.gen(function*() {
            if (headInserted) {
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
          // An event is appended when and only when a table changed: an
          // inserted head, or a new ledger generation. An `ExistingSame`
          // under an existing triple — the convergence re-record after a
          // crash between `attempts.finish` and `cache.put` — changed nothing
          // and appends nothing, which is the fold's idempotency. The append
          // joins this transaction, so the rows and the event describing them
          // are one commit.
          if (headInserted || ledgerInserted) {
            yield* journal.emitDurable(CacheEvents.recorded(entry))
          }
          return outcome
        })
      ).pipe(
        Effect.mapError(mapPersistenceError),
        Effect.tap((outcome) => Metric.update(CacheStoreMetrics.put[outcome._tag], 1))
      )
    })
  )

  const evict: Service["evict"] = Effect.fn("CacheStore.evict")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ keyDigest })
      yield* validateKey(keyDigest)
      yield* validateFence(options?.ifRecordedBy)
      const fenced = options?.ifRecordedBy
      return yield* journal.transact(
        Effect.gen(function*() {
          // The row is read before the DELETE because the `flows.cache.evicted`
          // event carries the deleted row's provenance and appends under its
          // recorded run. The read and the delete share one serialized write
          // transaction, so no foreign row can land between them; the
          // provenance predicate still rides in the DELETE itself (issue
          // #119), which keeps the compare-and-swap structural rather than
          // an artifact of transaction scheduling. Temporal fences its
          // mutable-state writes the same way — the guard is part of the
          // write.
          const rows = yield* (
            fenced === undefined
              ? sql<Pick<CacheRow, "recorded_run_id" | "recorded_event_seq">>`
                SELECT recorded_run_id, recorded_event_seq
                FROM flows_step_cache WHERE key_digest = ${keyDigest}
              `
              : sql<Pick<CacheRow, "recorded_run_id" | "recorded_event_seq">>`
                SELECT recorded_run_id, recorded_event_seq
                FROM flows_step_cache
                WHERE key_digest = ${keyDigest}
                  AND recorded_run_id = ${fenced.runId}
                  AND recorded_event_seq = ${fenced.eventSeq}
              `
          ).pipe(Effect.mapError(mapPersistenceError))
          const row = rows[0]
          // A compare-and-swap that matched no row appends nothing.
          if (row === undefined) {
            return false
          }
          const deleted = yield* sql`
            DELETE FROM flows_step_cache
            WHERE key_digest = ${keyDigest}
              AND recorded_run_id = ${row.recorded_run_id}
              AND recorded_event_seq = ${Number(row.recorded_event_seq)}
          `.raw.pipe(
            Effect.flatMap(affectedRows),
            Effect.mapError(mapPersistenceError)
          )
          if (deleted === 0) {
            return false
          }
          // The DELETE and the event describing it are one commit: a crash
          // can no longer leave a deleted row the journal cannot explain.
          yield* journal.emitDurable(CacheEvents.evicted({
            keyDigest,
            recordedRunId: row.recorded_run_id,
            recordedEventSeq: Number(row.recorded_event_seq)
          }))
          return true
        })
      ).pipe(Effect.mapError(mapPersistenceError))
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
  return CacheStore.of({
    get: Effect.fn("CacheStore.get")(() => unavailable("get")),
    put: Effect.fn("CacheStore.put")(() => unavailable("put")),
    evict: Effect.fn("CacheStore.evict")(() => unavailable("evict")),
    ...overrides
  })
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
 * Requires the `Journal` in context and the journal's migration set installed
 * alongside this package's: the fold appends `flows.cache.*` events to
 * `@smthrs/journal`'s tables in the same transaction as every row change, so
 * a row write without its event is a hole in the contract.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<CacheStore, never, Journal.Journal | SqlClient.SqlClient> = Layer.effect(CacheStore)(
  make
)
