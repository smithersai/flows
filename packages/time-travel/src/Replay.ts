import * as CacheStore from "@smthrs/journal/CacheStore"
import * as Journal from "@smthrs/journal/Journal"
import type { Entry, RunId, Seq } from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import type { Frame } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"

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
const lineageOf = (entry: Entry): string | undefined =>
  typeof entry.meta === "object" && entry.meta !== null && "lineageId" in entry.meta &&
    typeof entry.meta.lineageId === "string"
    ? entry.meta.lineageId
    : undefined
const cacheKeyOf = (entry: Entry): string | undefined =>
  typeof entry.meta === "object" && entry.meta !== null && "cacheKey" in entry.meta &&
    typeof entry.meta.cacheKey === "string"
    ? entry.meta.cacheKey
    : undefined
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
          const lineageId = lineageOf(entry)
          if (lineageId !== undefined && lineageId !== frame.lineageId) continue
          if (lineageId === frame.lineageId) foundLineage = true
          const cacheKey = cacheKeyOf(entry)
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
