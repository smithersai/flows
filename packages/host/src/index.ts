/**
 * @since 0.1.0
 *
 * `@smthrs/host` — the Host layer.
 *
 * Service modules are re-exported as namespaces, the way `effect`'s own index
 * does it, so each module keeps its `make` / `makeNoop` / `layerNoop` trio
 * without colliding with its neighbours: `Shell.layerNoop`,
 * `HttpTransport.layerNoop`.
 *
 * `Jj`, `Pty`, and the sandbox modules used to live here. They are their own
 * packages now — `@smthrs/jj`, `@smthrs/pty`, `@smthrs/sandbox` — and are NOT
 * re-exported: `HostServices.ts` depends on the first two because they remain
 * part of the closed Host surface, but every consumer imports them from their
 * own package.
 *
 * This entry point is **platform-neutral and browser-bundleable**: it holds
 * contracts, errors, and no-op layers only. Platform bundles live under
 * explicit subpaths, the way `effect` keeps `@effect/platform-node` out of
 * `effect`, so importing the contracts never resolves `node:` built-ins:
 *
 * ```ts
 * import { Shell } from "@smthrs/host"
 * import * as NodeHost from "@smthrs/host/node/NodeHost"
 * import * as BunHost from "@smthrs/host/bun/BunHost"
 * import * as BrowserHost from "@smthrs/host/browser/BrowserHost"
 * import * as TestHost from "@smthrs/host/test/TestHost"
 * ```
 *
 * `scripts/browser-check.mjs` at the repository root pins that property.
 */

/** Host-layer error types. */
export * as HostError from "./HostError.ts"

/** Host service contracts and their combined service type. */
export * from "./HostServices.ts"

/** HTTP transport contracts. */
export * as HttpTransport from "./HttpTransport.ts"

/** Shell operation contracts. */
export * as Shell from "./Shell.ts"
