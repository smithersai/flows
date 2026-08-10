/**
 * @since 0.1.0
 *
 * `@smthrs/pty` — the pseudo-terminal Host service.
 *
 * This entry point is **platform-neutral and browser-bundleable**: the
 * contract, its error, and the no-op layer only. Implementations live under
 * explicit subpaths, the way `effect` keeps `@effect/platform-node` out of
 * `effect`, so importing the contract never resolves a `node:` built-in:
 *
 * ```ts
 * import { Pty } from "@smthrs/pty"
 * import * as NodePty from "@smthrs/pty/node/NodePty"
 * import * as BunPty from "@smthrs/pty/bun/BunPty"
 * import * as BrowserPty from "@smthrs/pty/browser/BrowserPty"
 * ```
 *
 * `scripts/browser-check.mjs` at the repository root pins that property.
 */

export * from "./Pty.ts"
