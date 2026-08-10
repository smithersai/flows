/**
 * @since 0.1.0
 *
 * `@smthrs/platform-node` — the Node.js Host bundle.
 *
 * `@effect/platform-node` already ships `FileSystem`, `Path`, and
 * `ChildProcessSpawner` for Node, so this package adds only what `flows`
 * defines on top: the single-hop `HttpTransport`, and one `NodeHost.layer`
 * that composes the complete closed six-tag Host surface — including the Node
 * `Pty` and `Jj` adapters, which live in `@smthrs/pty` and `@smthrs/jj`.
 *
 * ```ts
 * import { NodeHost } from "@smthrs/platform-node"
 * ```
 *
 * **Node-only by construction.** The bundle resolves `node:child_process` and
 * friends; `scripts/browser-check.mjs` at the repository root pins that.
 */

/** The complete closed Host bundle for Node. */
export * as NodeHost from "./NodeHost.ts"

/** Single-hop `HttpTransport` over Undici. */
export * as NodeHttpTransport from "./NodeHttpTransport.ts"
