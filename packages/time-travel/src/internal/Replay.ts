import * as Journal from "@smthrs/journal/Journal"
import type { Entry, RunId, Seq } from "@smthrs/journal/JournalEvent"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/** A pure fold over durable journal evidence. @since 0.1.0 @category models */
export interface Projection<S> {
  readonly initial: S
  readonly reduce: (state: S, entry: Entry, sealed: unknown | undefined) => S
}
/** @since 0.1.0 @category models */
export interface ReplayOptions {
  readonly runId: string
  readonly pageSize?: number
}
/** @private */
const LineageMetadata = Schema.Struct({ lineageId: Schema.NonEmptyString })
/** @private */
const CacheMetadata = Schema.Struct({ cacheKey: Schema.NonEmptyString })
/**
 * Re-derives a projection from committed evidence only. This deliberately has
 * no dispatcher dependency: model and child results can only be cache reads.
 * @since 0.1.0 @category constructors
 */
export const rederive = <S>(
  frame: Frame,
  projection: Projection<S>,
  options: ReplayOptions
): Effect.Effect<S, TimeTravelError, Journal.Journal | CacheStore.CacheStore> =>
  Effect.fn("Replay.rederive")(() =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const cache = yield* CacheStore.CacheStore
      let after: Seq | undefined
      let state = projection.initial
      let foundLineage = false
      do {
        const page = yield* journal.entries({
          runId: options.runId as RunId,
          ...(after === undefined ? {} : { after }),
          limit: options.pageSize ?? 100
        }).pipe(Effect.mapError((cause) => error("unknown", "could not read journal", cause)))
        for (const entry of page.entries) {
          if (entry.seq > frame.seq) continue
          const lineageId = Option.getOrUndefined(
            Schema.decodeUnknownOption(LineageMetadata)(entry.meta)
          )?.lineageId
          if (lineageId !== undefined && lineageId !== frame.lineageId) continue
          if (lineageId === frame.lineageId) foundLineage = true
          const cacheKey = Option.getOrUndefined(
            Schema.decodeUnknownOption(CacheMetadata)(entry.meta)
          )?.cacheKey
          const sealed = cacheKey === undefined
            ? undefined
            : yield* cache.get(cacheKey).pipe(
              Effect.mapError((cause) => error("unknown", "could not read sealed result", cause)),
              Effect.map((entry) => entry._tag === "Some" ? entry.value.result : undefined)
            )
          state = projection.reduce(state, entry, sealed)
        }
        after = page.entries.at(-1)?.seq
        if (!page.hasMore) break
      } while (after !== undefined)
      if (!foundLineage) {
        return yield* Effect.fail(error("not_found", `lineage ${frame.lineageId} is not present in ${options.runId}`))
      }
      return state
    })
  )()
