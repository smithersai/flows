/**
 * @since 0.1.0
 *
 * `@smthrs/jj-next` — jujutsu as a Host service.
 *
 * This entry point is **platform-neutral and browser-bundleable**: the
 * contract, its error, and the no-op layer only. Implementations live under
 * explicit subpaths, the way `effect` keeps `@effect/platform-node` out of
 * `effect`, so importing the contract never resolves a `node:` built-in:
 *
 * ```ts
 * import { Jj } from "@smthrs/jj-next"
 * import * as NodeJj from "@smthrs/jj-next/node/NodeJj"
 * import * as BunJj from "@smthrs/jj-next/bun/BunJj"
 * import * as BrowserJj from "@smthrs/jj-next/browser/BrowserJj"
 * ```
 *
 * `scripts/browser-check.mjs` at the repository root pins that property.
 */

export * from "./Jj.ts"
