/**
 * @since 0.1.0
 *
 * `@smithers/host` — the Host layer.
 *
 * Service modules are re-exported as namespaces, the way `effect`'s own index
 * does it, so each module keeps its `make` / `makeNoop` / `layerNoop` trio
 * without colliding with its neighbours: `Shell.layerNoop`, `Pty.layerNoop`.
 */
export * as HostError from "./HostError.ts"
export * from "./HostServices.ts"
export * as HttpTransport from "./HttpTransport.ts"
export * as Jj from "./Jj.ts"
export * as Pty from "./Pty.ts"
export * as Shell from "./Shell.ts"

// Platform bundles. Each provides the `layer` for every tag in the closed list.
export * as BrowserHost from "./browser/BrowserHost.ts"
export * as BunHost from "./bun/BunHost.ts"
export * as NodeHost from "./node/NodeHost.ts"
export * as RemoteSandbox from "./RemoteSandbox.ts"
export * as SandboxHealth from "./SandboxHealth.ts"
export * as TestHost from "./test/TestHost.ts"
