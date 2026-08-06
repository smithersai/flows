# Browser support

Browser support is a hard requirement of this repository, and it is met the only way an Effect codebase can meet it: **host access goes through a layer**, so a module that only depends on contracts never resolves a `node:` built-in. This page states exactly which entry points honour that today, which do not, and what proves it.

Nothing here is a claim about what *should* bundle. Every row is executed by `scripts/browser-check.mjs` — `npm run browser` locally, one step in [CI](../../.github/workflows/ci.yml) — which bundles each entry point with esbuild's `platform: "browser"`.

## Browser entry points

These bundle for the browser. A resolution error in any of them fails the build.

| Entry point | Notes |
| --- | --- |
| `@smithers/host` | Shell, Pty, Jj, and HttpTransport contracts, `HostError`, `RemoteSandbox`, `SandboxHealth`, and the no-op layers |
| `@smithers/host/browser/BrowserHost` | `layer({ bash, fs })` over an injected browser filesystem and bash-like shell; PTY and Jujutsu report `unsupported` |
| `@smithers/kernel` | Capabilities, grants, and the permission-decorated host services |
| `@smithers/keys` | Canonical serialization, digests, and step keys |
| `@smithers/database` | The driver-neutral `Database` contract; wrap any Effect `SqlClient` with `Database.make` |
| `@smithers/journal` | Journal, run/attempt/cache stores, migrations, and projections, all over the `Database` contract |
| `@smithers/engine` | Flow, activity, durable clock/deferred/queue, retry policy, and step identity |
| `@smithers/plugin` | Hooks, resolution, and the config pipeline |
| `@smithers/sync` | Read-only journal sync and branch protocols |
| `@smithers/time-travel` | Frames, replay, fork, rewind, compensation, and recovery |

Bundling is not running: `@smithers/journal` bundles because it depends on the `Database` *contract*, and a browser application still has to supply a browser SQL client (for example Effect's sqlite-wasm OPFS worker) to that contract. Bundling is the property that makes such a composition possible; the sqlite-wasm layer itself is not shipped here — see [implementation status](implementation-status.md).

## Node entry points

These are Node-only, deliberately. The gate asserts each one *still* fails to bundle for the browser, and fails the build if it stops failing — a Node-only entry point cannot quietly become browser-safe without this page being corrected.

| Entry point | Why |
| --- | --- |
| `@smithers/engine-store` | `EngineStore` reads `process.pid` and imports `randomUUID` from `node:crypto`. These two are the complete browser-gap inventory for a browser composition (issue #114). |
| `@smithers/flows` | The barrel re-exports `@smithers/engine-store`. **Browser consumers import the per-package roots above rather than the barrel.** |
| `@smithers/host/node/NodeHost`, `@smithers/host/bun/BunHost` | Child processes, Node/Bun filesystem, PTY, and Jujutsu; the Bun bundle falls back to the `@effect/platform-node` adapters off Bun |
| `@smithers/host/test/TestHost` | `effect/testing`'s `TestClock` imports `node:assert`, so the deterministic host is Node-only even though its own adapters are pure |
| `@smithers/database/node/NodeDatabase`, `@smithers/database/test/TestDatabase` | `node:sqlite` through `@effect/sql-sqlite-node` |
| `@smithers/journal/test/TestJournal` | Composes `TestDatabase` |

## The rule this encodes

A package root exports **contracts**; a platform implementation lives under a subpath named for its platform — `/node`, `/bun`, `/browser`, `/test` — the way `effect` keeps `@effect/platform-node` out of `effect`. A root that re-exports an implementation resolves that implementation's imports for every consumer, including browser ones, before any bundler can tree-shake it. `packages/host/test/index.test.ts` pins that rule for the host root as a unit test, and the browser gate pins it for every entry point in this table.

## The honest claim

“`flows` has browser-safe host contracts and a working `BrowserHost`, and its journal, keys, kernel, engine, sync, and time-travel surfaces bundle for the browser. Its durable engine composition is Node/SQLite-first.” Do not shorten that to “the library is browser compatible” while `@smithers/engine-store` and the barrel are in this page's second table.
