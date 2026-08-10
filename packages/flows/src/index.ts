/**
 * @since 0.1.0
 *
 * `@smthrs/flows` — the barrel package for the durable flow engine.
 *
 * Every engine package is re-exported here as a namespace, the way `effect`'s
 * own index does it, so one dependency gives you the whole engine surface
 * without collapsing each package's `make` / `makeNoop` / `layerNoop` trio into
 * a shared namespace: `Kernel.ChildProcessSpawner.layerNoop`,
 * `Journal.Store.layer`.
 *
 * The `@smthrs/platform-*` packages are deliberately NOT re-exported, for the
 * same reason `effect`'s index does not re-export `@effect/platform-node`: a
 * platform bundle is chosen by the program that runs, not by the library it
 * depends on, and pulling all three in here would make one import resolve
 * `node:child_process`, ZenFS, and Bun at once. Import
 * `@smthrs/platform-node`, `@smthrs/platform-bun`, or
 * `@smthrs/platform-browser` directly.
 *
 * Depend on the individual `@smthrs/*` packages instead when you want a
 * narrower dependency footprint — this barrel is a convenience, not a new
 * seam. The only API of its own is {@link namespaces}, the runtime list of
 * the re-exported namespace names.
 *
 * ```ts
 * import { Engine, Kernel, Journal } from "@smthrs/flows"
 * ```
 *
 * One caveat: `Plugin` is re-exported as a namespace, but declaration merging
 * into `FlowsHooks` must target the owning module — `declare module
 * "@smthrs/plugin"`, never `"@smthrs/flows"`. A re-export is not an
 * augmentation target.
 */

export * as Canonical from "@smthrs/canonical"
export * as Crypto from "@smthrs/crypto"
export * as Database from "@smthrs/database"
export * as Engine from "@smthrs/engine"
export * as EngineStore from "@smthrs/engine-store"
export * as Jj from "@smthrs/jj"
export * as Journal from "@smthrs/journal"
export * as Kernel from "@smthrs/kernel"
export * as Keys from "@smthrs/keys"
export * as Plugin from "@smthrs/plugin"
export * as Pty from "@smthrs/pty"
export * as Sandbox from "@smthrs/sandbox"
export * as Sync from "@smthrs/sync"
export * as TimeTravel from "@smthrs/time-travel"

/**
 * The namespace names this barrel re-exports, in export order.
 *
 * Pure re-exports carry no executable statements, so before this constant
 * the package's enforced 100% coverage gate evaluated an empty denominator
 * (`100% (0/0)`) and could never go red while the conformance suite
 * presented it as gated like every sibling (issue #169). This is the
 * barrel's one runtime value: it gives the gate a real denominator, and the
 * barrel test pins it against the derived `packages/*` universe so it can
 * never drift from the re-exports above.
 *
 * @since 0.1.0
 * @category models
 */
export const namespaces = [
  "Canonical",
  "Crypto",
  "Database",
  "Engine",
  "EngineStore",
  "Jj",
  "Journal",
  "Kernel",
  "Keys",
  "Plugin",
  "Pty",
  "Sandbox",
  "Sync",
  "TimeTravel"
] as const
