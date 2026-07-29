/** Complete Cloudflare Workers Host bundle. @since 0.1.0 */
import { HostServiceIds } from "@flows/host/HostServices"
import type * as HttpTransport from "@flows/host/HttpTransport"
import type * as Jj from "@flows/host/Jj"
import type * as Pty from "@flows/host/Pty"
import type * as Shell from "@flows/host/Shell"
import { Layer, Path } from "effect"
import type { FileSystem } from "effect/FileSystem"
import * as CloudflareFileSystem from "./CloudflareFileSystem.ts"
import * as CloudflareHttpTransport from "./CloudflareHttpTransport.ts"
import * as CloudflareJj from "./CloudflareJj.ts"
import * as CloudflarePty from "./CloudflarePty.ts"
import * as CloudflareSandbox from "./CloudflareSandbox.ts"
import * as CloudflareShell from "./CloudflareShell.ts"

export {
  CloudflareFileSystem,
  CloudflareHttpTransport,
  CloudflareJj,
  CloudflarePty,
  CloudflareSandbox,
  CloudflareShell
}

/** The closed Host service union supplied by Cloudflare Workers. @category models @since 0.1.0 */
export type CloudflareHost = FileSystem | Path.Path | Shell.Shell | Pty.Pty | Jj.Jj | HttpTransport.HttpTransport

/** Stable implementation identities for the six Host slots. @category models @since 0.1.0 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  [HostServiceIds[0]]: "cloudflare-object-storage",
  [HostServiceIds[1]]: "cloudflare-path",
  [HostServiceIds[2]]: "cloudflare-edge-unsupported",
  [HostServiceIds[3]]: "cloudflare-edge-unsupported",
  [HostServiceIds[4]]: "cloudflare-edge-unsupported",
  [HostServiceIds[5]]: "cloudflare-workers-fetch"
}

/** Default Workers layer: object storage, Workers fetch, and typed local-process failures. @category layers @since 0.1.0 */
export const layer = (store: CloudflareFileSystem.ObjectStore): Layer.Layer<CloudflareHost> =>
  Layer.mergeAll(
    CloudflareFileSystem.layer(store),
    Path.layer,
    CloudflareHttpTransport.layer,
    CloudflareShell.layer,
    CloudflarePty.layer,
    CloudflareJj.layer
  )

/** Same complete Host surface, routing shell operations to a remote sandbox. @category layers @since 0.1.0 */
export const layerWithSandbox = (
  store: CloudflareFileSystem.ObjectStore,
  provider: CloudflareSandbox.SandboxProvider
): Layer.Layer<CloudflareHost> =>
  Layer.mergeAll(
    CloudflareFileSystem.layer(store),
    Path.layer,
    CloudflareHttpTransport.layer,
    CloudflareSandbox.layerShell(provider),
    CloudflarePty.layer,
    CloudflareJj.layer
  )
