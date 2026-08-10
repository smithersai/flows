/**
 * @since 0.1.0
 *
 * `@smthrs/sandbox` — remote sandbox execution and liveness.
 *
 * Modules are re-exported as namespaces, the way `effect`'s own index does it,
 * so each keeps its `make` / `makeNoop` / `layerNoop` trio without colliding
 * with its neighbour.
 *
 * The package is **platform-neutral and browser-bundleable**: it adapts a
 * provider a caller hands it onto `@smthrs/host`'s `Shell` contract and owns no
 * host access of its own. `scripts/browser-check.mjs` at the repository root
 * pins that property.
 *
 * ```ts
 * import { RemoteSandbox, SandboxHealth } from "@smthrs/sandbox"
 * ```
 */

/** Provider-neutral remote process execution. */
export * as RemoteSandbox from "./RemoteSandbox.ts"

/** Sandbox health-check contracts. */
export * as SandboxHealth from "./SandboxHealth.ts"
