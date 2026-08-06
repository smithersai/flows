/**
 * @since 0.1.0
 *
 * `@smithers/host` — the Host layer.
 *
 * Service modules are re-exported as namespaces, the way `effect`'s own index
 * does it, so each module keeps its `make` / `makeNoop` / `layerNoop` trio
 * without colliding with its neighbours: `Shell.layerNoop`, `Pty.layerNoop`.
 *
 * This entry point is **platform-neutral and browser-bundleable**: it holds
 * contracts, errors, and no-op layers only. Platform bundles live under
 * explicit subpaths, the way `effect` keeps `@effect/platform-node` out of
 * `effect`, so importing the contracts never resolves `node:` built-ins:
 *
 * ```ts
 * import { Shell } from "@smithers/host"
 * import * as NodeHost from "@smithers/host/node/NodeHost"
 * import * as BunHost from "@smithers/host/bun/BunHost"
 * import * as BrowserHost from "@smithers/host/browser/BrowserHost"
 * import * as TestHost from "@smithers/host/test/TestHost"
 * ```
 *
 * `scripts/browser-check.mjs` at the repository root pins that property.
 */
export * as HostError from "./HostError.ts"
export * from "./HostServices.ts"
export * as HttpTransport from "./HttpTransport.ts"
export * as Jj from "./Jj.ts"
export * as Pty from "./Pty.ts"
export * as RemoteSandbox from "./RemoteSandbox.ts"
export * as SandboxHealth from "./SandboxHealth.ts"
export * as Shell from "./Shell.ts"
