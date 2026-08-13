/**
 * Default OTLP export wiring for flows telemetry.
 *
 * The store packages define and update their own metric handles
 * (`JournalMetrics`, `RunStoreMetrics`, `CacheStoreMetrics`,
 * `ArtifactStoreMetrics`, `DatabaseMetrics`) and open spans through Effect's
 * tracer; this package is the exporter they deliberately leave out. It only
 * composes what `effect` already ships, so it is browser-bundleable.
 *
 * ```ts
 * import * as Otlp from "@smthrs/observability-next"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category layers
 * @since 0.1.0
 */
export * as Otlp from "./Otlp.ts"
