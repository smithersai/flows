/**
 * @since 0.1.0
 *
 * `@smithers/flows` — the barrel package for the durable flow engine.
 *
 * Every engine package is re-exported here as a namespace, the way `effect`'s
 * own index does it, so one dependency gives you the whole engine surface
 * without collapsing each package's `make` / `makeNoop` / `layerNoop` trio into
 * a shared namespace: `Host.Shell.layerNoop`, `Journal.Store.layer`.
 *
 * Depend on the individual `@smithers/*` packages instead when you want a
 * narrower dependency footprint — this barrel is a convenience, not a new
 * seam. It adds no API of its own.
 *
 * ```ts
 * import { Engine, Host, Journal } from "@smithers/flows"
 * ```
 *
 * One caveat: `Plugin` is re-exported as a namespace, but declaration merging
 * into `FlowsHooks` must target the owning module — `declare module
 * "@smithers/plugin"`, never `"@smithers/flows"`. A re-export is not an
 * augmentation target.
 */

export * as Database from "@smithers/database"
export * as Engine from "@smithers/engine"
export * as EngineStore from "@smithers/engine-store"
export * as Host from "@smithers/host"
export * as Journal from "@smithers/journal"
export * as Kernel from "@smithers/kernel"
export * as Keys from "@smithers/keys"
export * as Plugin from "@smithers/plugin"
export * as Sync from "@smithers/sync"
export * as TimeTravel from "@smithers/time-travel"
