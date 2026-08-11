/**
 * Aggregate Bun Host bundle.
 *
 * Runtime-specific dependencies stay inside this package; callers get the same
 * closed five-service Host surface every other bundle provides.
 *
 * There is no Bun shell module: running a command is Effect's
 * `ChildProcessSpawner`, and `@effect/platform-bun`'s implementation is
 * `@effect/platform-node-shared`'s re-exported — the same code on both
 * runtimes, so no runtime detection is needed here.
 *
 * @since 0.1.0
 */
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import type { Jj } from "@smthrs/jj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import { HostServiceIds } from "@smthrs/kernel/HostServices"
import type { HttpTransport } from "@smthrs/kernel/HttpTransport"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BunFileSystem from "./BunFileSystem.ts"
import * as BunHttpTransport from "./BunHttpTransport.ts"

/**
 * Bun platform modules for selectively providing individual services.
 *
 * `BunJj` is deliberately absent: it belongs to `@smthrs/jj` and is imported
 * from there, never re-exported here.
 *
 * @category re-exports
 * @since 0.1.0
 */
export { BunChildProcessSpawner, BunFileSystem, BunHttpTransport }

/**
 * The complete closed Host service union provided by Bun.
 *
 * @category models
 * @since 0.1.0
 */
export type BunHost = FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpTransport

/**
 * Stable implementation identities keyed by the closed Host service slots.
 *
 * Planners can digest these values in `HostServiceIds` order without learning
 * about Bun implementation modules.
 *
 * These strings are identity tokens digested into step keys, not import
 * specifiers, so a rename invalidates every cached step run against a Bun
 * host ([[Step Keys]], `docs/concepts/step-keys.md`).
 *
 * @category models
 * @since 0.1.0
 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  [HostServiceIds[0]]: "@smthrs/platform-bun/BunFileSystem",
  [HostServiceIds[1]]: "effect/Path",
  [HostServiceIds[2]]: "@effect/platform-bun/BunChildProcessSpawner",
  [HostServiceIds[3]]: "@smthrs/jj/bun/BunJj",
  [HostServiceIds[4]]: "@smthrs/platform-bun/BunHttpTransport"
}

/** The two services `BunChildProcessSpawner` resolves paths and files with. */
const platform = Layer.mergeAll(BunFileSystem.layer, Path.layer)

/**
 * Provides all five Bun Host services, including the runtime-independent Path
 * service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BunHost> = Layer.mergeAll(
  platform,
  Layer.provide(BunChildProcessSpawner.layer, platform),
  BunJj.layer,
  BunHttpTransport.layer
)
