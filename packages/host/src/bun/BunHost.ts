/**
 * Aggregate Bun host services layer.
 *
 * Runtime-specific dependencies remain isolated below `src/bun`; callers use
 * the same closed six-service Host surface as every other bundle.
 *
 * @since 0.1.0
 */
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { HostServiceIds } from "../HostServices.ts"
import type { HttpTransport } from "../HttpTransport.ts"
import type { Jj } from "../Jj.ts"
import type { Pty } from "../Pty.ts"
import type { Shell } from "../Shell.ts"
import * as BunFileSystem from "./BunFileSystem.ts"
import * as BunHttpTransport from "./BunHttpTransport.ts"
import * as BunJj from "./BunJj.ts"
import * as BunPty from "./BunPty.ts"
import * as BunShell from "./BunShell.ts"

/**
 * Bun platform modules for selectively providing individual services.
 *
 * @category re-exports
 * @since 0.1.0
 */
export { BunFileSystem, BunHttpTransport, BunJj, BunPty, BunShell }

/**
 * The complete closed Host service union provided by Bun.
 *
 * @category models
 * @since 0.1.0
 */
export type BunHost = FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport

/**
 * Stable implementation identities keyed by the closed Host service slots.
 *
 * Planners can digest these values in `HostServiceIds` order without learning
 * about Bun implementation modules.
 *
 * @category models
 * @since 0.1.0
 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  [HostServiceIds[0]]: "@smithers/host/bun/BunFileSystem",
  [HostServiceIds[1]]: "effect/Path",
  [HostServiceIds[2]]: "@smithers/host/bun/BunShell",
  [HostServiceIds[3]]: "@smithers/host/bun/BunPty",
  [HostServiceIds[4]]: "@smithers/host/bun/BunJj",
  [HostServiceIds[5]]: "@smithers/host/bun/BunHttpTransport"
}

/**
 * Provides all six Bun Host services, including the runtime-independent Path
 * service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BunHost> = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunShell.layer,
  BunPty.layer,
  BunJj.layer,
  BunHttpTransport.layer
)
