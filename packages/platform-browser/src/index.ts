/**
 * @since 0.1.0
 *
 * `@smthrs/platform-browser` — the two platform services `@effect/platform-browser`
 * does not ship.
 *
 * `effect`'s browser platform package covers HTTP, sockets, workers, key-value
 * storage, and crypto, but a browser tab has no `node:fs` and no `fork`, so it
 * ships neither a `FileSystem` nor a `ChildProcessSpawner`. A tab *can* have
 * both, given a virtual filesystem (ZenFS) and an in-page bash interpreter
 * (just-bash). Neither is an npm dependency here: both are taken as structural
 * slices, so the page decides which backend is mounted.
 *
 * ```ts
 * import { BrowserServices } from "@smthrs/platform-browser"
 *
 * const layer = BrowserServices.layer({ bash, fs })
 * ```
 *
 * Everything in this package is browser-bundleable; `scripts/browser-check.mjs`
 * at the repository root pins that property.
 */

/** `ChildProcessSpawner` over an in-page bash interpreter. */
export * as BrowserChildProcessSpawner from "./BrowserChildProcessSpawner.ts"

/** `FileSystem` over a ZenFS-shaped promises API. */
export * as BrowserFileSystem from "./BrowserFileSystem.ts"

/** The aggregate browser platform services layer. */
export * as BrowserServices from "./BrowserServices.ts"
