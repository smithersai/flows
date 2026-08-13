/**
 * The cache counters: lookups and recordings land in the registry the caller
 * provided, keyed by the outcome the store actually resolved.
 */
import type { DurableWriter } from "@smthrs/database-next"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as CacheStoreMetrics from "../src/CacheStoreMetrics.ts"
import * as Migrations from "../src/Migrations.ts"

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | CacheStore>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(CacheStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const entry = {
  keyDigest: "digest-metrics",
  result: { output: "ok" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 7
} as const

describe("CacheStoreMetrics", () => {
  it("counts misses, hits, and every put outcome through the provided registry", async () => {
    await migrated(Effect.gen(function*() {
      const store = yield* CacheStore

      expect(yield* store.get(entry.keyDigest)).toMatchObject({ _tag: "None" })
      expect(yield* store.put(entry)).toEqual({ _tag: "Inserted" })
      expect(yield* store.get(entry.keyDigest)).toMatchObject({ _tag: "Some" })
      expect(yield* store.put(entry)).toEqual({ _tag: "ExistingSame" })
      expect(yield* store.put({ ...entry, result: { output: "different" } })).toEqual({ _tag: "Conflict" })

      expect(yield* count(CacheStoreMetrics.miss)).toBe(1)
      expect(yield* count(CacheStoreMetrics.hit)).toBe(1)
      expect(yield* count(CacheStoreMetrics.put.Inserted)).toBe(1)
      expect(yield* count(CacheStoreMetrics.put.ExistingSame)).toBe(1)
      expect(yield* count(CacheStoreMetrics.put.Conflict)).toBe(1)
      // The unattributed handles aggregate nothing on their own; every update
      // carried an outcome attribute.
      expect(yield* count(CacheStoreMetrics.lookups)).toBe(0)
      expect(yield* count(CacheStoreMetrics.puts)).toBe(0)
    }))
  })
})
