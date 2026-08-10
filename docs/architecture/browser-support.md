# Browser support

Browser support is a hard requirement of this repository, and it is met the only way an Effect codebase can meet it: **host access goes through a layer**, so a module that only depends on contracts never resolves a `node:` built-in. This page states exactly which entry points honour that today, which do not, and what proves it.

Nothing here is a claim about what *should* bundle. Every row is executed by `scripts/browser-check.mjs` — `npm run browser` locally, one step in [CI](../../.github/workflows/ci.yml) — which bundles each entry point with esbuild's `platform: "browser"`.

## Browser entry points

These bundle for the browser. A resolution error in any of them fails the build.

| Entry point | Notes |
| --- | --- |
| `@smthrs/canonical` | RFC 8785 canonical JSON as an Effect Schema |
| `@smthrs/host` | The closed service list, the Shell and HttpTransport contracts, `HostError`, and the no-op layers |
| `@smthrs/host/browser/BrowserHost` | `layer({ bash, fs })` over an injected browser filesystem and bash-like shell; PTY and Jujutsu report `unsupported` |
| `@smthrs/jj` | The `Jj` contract, `JjError`, and the no-op layer |
| `@smthrs/jj/browser/BrowserJj` | `layerUnsupported` — every jj operation reports `not_installed` |
| `@smthrs/pty` | The `Pty` contract, `PtyError`, and the no-op layer |
| `@smthrs/pty/browser/BrowserPty` | `layerUnsupported` — `spawn` reports `unsupported` |
| `@smthrs/sandbox` | `RemoteSandbox` provider adaptation and the `SandboxHealth` probe; it owns no host access of its own |
| `@smthrs/platform-browser` | effect's `FileSystem` over a ZenFS-shaped promises API and effect's `ChildProcessSpawner` over an in-page bash interpreter, plus the `BrowserServices` aggregate |
| `@smthrs/kernel` | Capabilities, grants, and the permission-decorated host services |
| `@smthrs/crypto` | Injected cryptographic schemas |
| `@smthrs/keys` | Canonical workflow keys |
| `@smthrs/database` | The driver-neutral `Database` contract; wrap any Effect `SqlClient` with `Database.make` |
| `@smthrs/journal` | Journal, run/attempt/cache stores, migrations, and projections, all over the `Database` contract |
| `@smthrs/engine` | Flow, activity, durable clock/deferred/queue, retry policy, and step identity |
| `@smthrs/plugin` | Hooks, resolution, and the config pipeline |
| `@smthrs/sync` | Read-only journal sync and branch protocols |
| `@smthrs/time-travel` | Frames, replay, fork, rewind, compensation, and recovery |

Bundling is not running: `@smthrs/journal` bundles because it depends on the `Database` *contract*, and a browser application still has to supply a browser SQL client (for example Effect's sqlite-wasm OPFS worker) to that contract. Bundling is the property that makes such a composition possible; the sqlite-wasm layer itself is not shipped here — see [implementation status](implementation-status.md).

## Node entry points

These are Node-only, deliberately. The gate asserts each one *still* fails to bundle for the browser, and fails the build if it stops failing — a Node-only entry point cannot quietly become browser-safe without this page being corrected.

| Entry point | Why |
| --- | --- |
| `@smthrs/engine-store` | `EngineStore` reads `process.pid` and imports `randomUUID` from `node:crypto`. These two are the complete browser-gap inventory for a browser composition (issue #114). |
| `@smthrs/flows` | The barrel re-exports `@smthrs/engine-store`. **Browser consumers import the per-package roots above rather than the barrel.** |
| `@smthrs/host/node/NodeHost`, `@smthrs/host/bun/BunHost` | Child processes, Node/Bun filesystem, PTY, and Jujutsu; the Bun bundle falls back to the `@effect/platform-node` adapters off Bun |
| `@smthrs/jj/node/NodeJj`, `@smthrs/jj/bun/BunJj` | `node:child_process`; the jj CLI is spawned with argv and never a shell string |
| `@smthrs/pty/node/NodePty`, `@smthrs/pty/bun/BunPty` | `node:child_process`; piped-stdio children behind the bounded replay ring |
| `@smthrs/host/test/TestHost` | `effect/testing`'s `TestClock` imports `node:assert`, so the deterministic host is Node-only even though its own adapters are pure |
| `@smthrs/database/node/NodeDatabase`, `@smthrs/database/test/TestDatabase` | `node:sqlite` through `@effect/sql-sqlite-node` |
| `@smthrs/journal/test/TestJournal` | Composes `TestDatabase` |

## The rule this encodes

A package root exports **contracts**; a platform implementation lives under a subpath named for its platform — `/node`, `/bun`, `/browser`, `/test` — the way `effect` keeps `@effect/platform-node` out of `effect`. A root that re-exports an implementation resolves that implementation's imports for every consumer, including browser ones, before any bundler can tree-shake it. `packages/host/test/index.test.ts` pins that rule for the host root as a unit test — including the constraint that `Jj`, `Pty`, `RemoteSandbox`, and `SandboxHealth`, now their own packages, are not re-exported from it, and the browser gate pins it for every entry point in this table.

## The honest claim

“`flows` has browser-safe canonical JSON, crypto, and host contracts with a working `BrowserHost`, and its journal, keys, kernel, engine, sync, and time-travel surfaces bundle for the browser. Its durable engine composition is Node/SQLite-first.” Do not shorten that to “the library is browser compatible” while `@smthrs/engine-store` and the barrel are in this page's second table.
