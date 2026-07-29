/**
 * Complete Vercel Edge host bundle.
 *
 * Every member of the closed Host surface is provided. Edge process, PTY, and
 * jj operations fail in their typed channels; use `layerWithSandbox` when
 * process-shaped work is routed to Vercel Sandbox.
 *
 * @since 0.1.0
 */
import { HostServiceIds } from "@flows/host/HostServices"
import type { HttpTransport } from "@flows/host/HttpTransport"
import type { Jj } from "@flows/host/Jj"
import type { Pty } from "@flows/host/Pty"
import type { Shell } from "@flows/host/Shell"
import { Layer, Path } from "effect"
import type { FileSystem } from "effect"
import * as VercelFileSystem from "./VercelFileSystem.ts"
import * as VercelHttpTransport from "./VercelHttpTransport.ts"
import * as VercelJj from "./VercelJj.ts"
import * as VercelPty from "./VercelPty.ts"
import * as VercelSandbox from "./VercelSandbox.ts"
import * as VercelShell from "./VercelShell.ts"

export { VercelFileSystem, VercelHttpTransport, VercelJj, VercelPty, VercelSandbox, VercelShell }

/** Union of all six services in the Vercel Edge bundle. @category models @since 0.1.0 */
export type VercelHost = FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport

/** Stable implementation identities for this bundle's six Host slots. @category models @since 0.1.0 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  [HostServiceIds[0]]: "vercel-blob-kv",
  [HostServiceIds[1]]: "vercel-path",
  [HostServiceIds[2]]: "vercel-edge-unsupported",
  [HostServiceIds[3]]: "vercel-edge-unsupported",
  [HostServiceIds[4]]: "vercel-edge-unsupported",
  [HostServiceIds[5]]: "vercel-fetch"
}

/** Options for the persistent edge bundle. @category models @since 0.1.0 */
export interface Options {
  readonly storage: VercelFileSystem.Storage
}

/** Provides all six Host services for Vercel Edge. @category layers @since 0.1.0 */
export const layer = (options: Options): Layer.Layer<VercelHost> =>
  Layer.mergeAll(
    VercelFileSystem.layer(options.storage),
    VercelHttpTransport.layer,
    Path.layer,
    VercelShell.layer,
    VercelPty.layer,
    VercelJj.layer
  )

/** Provides all six services while replacing Edge Shell with remote Sandbox. @category layers @since 0.1.0 */
export const layerWithSandbox = (
  options: Options,
  provider: VercelSandbox.Provider
): Layer.Layer<VercelHost> =>
  Layer.mergeAll(
    VercelFileSystem.layer(options.storage),
    VercelHttpTransport.layer,
    Path.layer,
    VercelSandbox.layerWithSandbox(provider),
    VercelPty.layer,
    VercelJj.layer
  )
