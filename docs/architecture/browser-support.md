# Browser support

Browser support is a hard requirement of this repository, and it is met the only way an Effect codebase can meet it: **host access goes through a layer**, so a module that only depends on contracts never resolves a `node:` built-in. This page states exactly which entry points honour that today, which do not, and what proves it.

Nothing here is a claim about what *should* bundle. Every row is executed by `scripts/browser-check.mjs` — `npm run browser` locally, one step in [CI](../../.github/workflows/ci.yml) — which bundles each entry point with esbuild's `platform: "browser"`.

## Browser entry points

These bundle for the browser. A resolution error in any of them fails the build.

| Entry point | Notes |
| --- | --- |
| `@smthrs/canonical` | RFC 8785 canonical JSON as an Effect Schema |
| `@smthrs/platform-browser/BrowserHost` | `layer({ bash, fs })` over an injected browser filesystem and bash interpreter; Jujutsu reports `unsupported` |
| `@smthrs/jj` | The `Jj` contract, `JjError`, and the no-op layer |
| `@smthrs/jj/browser/BrowserJj` | `layerUnsupported` — every jj operation reports `not_installed` |
| `@smthrs/sandbox` | `RemoteSandbox` provider adaptation and the `SandboxHealth` probe; it owns no host access of its own |
| `@smthrs/platform-browser` | effect's `FileSystem` over a ZenFS-shaped promises API and effect's `ChildProcessSpawner` over an in-page bash interpreter, plus the `BrowserServices` aggregate and the fetch-backed `HttpTransport` |
| `@smthrs/kernel` | The closed host service list, `CommandLine.render`, capabilities, grants, and the permission-decorated host services |
| `@smthrs/crypto` | Injected cryptographic schemas |
| `@smthrs/keys` | Canonical flow keys |
| `@smthrs/database` | The driver-neutral `DurableWriter` write boundary over Effect's own `SqlClient` service |
| `@smthrs/journal` | The journal, its migration, projections, and redaction, all over `SqlClient` and the `DurableWriter` contract |
| `@smthrs/run-store` | Run and attempt stores, ownership arbitration, and their migration, over the same contracts |
| `@smthrs/step-cache` | The step cache and its migration, over the same contracts |
| `@smthrs/flow` | Flow, activity, durable clock/deferred/queue, retry policy, step identity, and the `FlowRuntime` port |
| `@smthrs/engine` | The engine that executes flows: the encoded seam, the in-memory runtime, and the RPC/HTTP façades |
| `@smthrs/engine-store` | The durable engine over the journal. Owner identity — the last `process.pid` and `node:crypto` read — enters through the `OwnerIdentity` service, whose default draws an incarnation number where a host has no process (issue #114) |
| `@smthrs/flows` | The barrel. It re-exports every engine package, so it bundles exactly when they all do |
| `@smthrs/sync` | Read-only journal sync and branch protocols |
| `@smthrs/time-travel` | Frames, replay, fork, rewind, compensation, and recovery |

Bundling is not running: `@smthrs/journal` bundles because it depends on the `DurableWriter` *contract* and Effect's `SqlClient`, and a browser application still has to supply a browser SQL client (for example Effect's sqlite-wasm OPFS worker) to that contract. Bundling is the property that makes such a composition possible; the sqlite-wasm layer itself is not shipped here — see [implementation status](implementation-status.md).

## Node entry points

These are Node-only, deliberately. The gate asserts each one *still* fails to bundle for the browser, and fails the build if it stops failing — a Node-only entry point cannot quietly become browser-safe without this page being corrected.

| Entry point | Why |
| --- | --- |
| `@smthrs/platform-node`, `@smthrs/platform-bun` | Child processes, Node/Bun filesystem, and Jujutsu; the Bun bundle falls back to the `@effect/platform-node` adapters off Bun |
| `@smthrs/jj/node/NodeJj`, `@smthrs/jj/bun/BunJj` | `node:child_process`; the jj CLI is spawned with argv and never a shell string |
| `@smthrs/kernel/test/TestHost` | `effect/testing`'s `TestClock` imports `node:assert`, so the deterministic host is Node-only even though its own adapters are pure |
| `@smthrs/database/node/NodeDatabase`, `@smthrs/database/test/TestDatabase` | `node:sqlite` through `@effect/sql-sqlite-node` |
| `@smthrs/journal/test/TestJournal` | Composes `TestDatabase` |

## The rule this encodes

A platform-neutral package root exports **contracts**; an implementation lives in its platform package — `@smthrs/platform-node`, `@smthrs/platform-bun`, or `@smthrs/platform-browser` — the way `effect` keeps `@effect/platform-node` out of `effect`. A neutral root that re-exports an implementation resolves that implementation's imports for every consumer, including browser ones, before any bundler can tree-shake it. Package barrel tests pin the namespaces each root exports, and the browser gate pins every browser-safe entry point in this table.

## The honest claim

“`flows` has browser-safe canonical JSON, crypto, and host contracts with a working `BrowserHost`, and its journal, keys, kernel, engine, engine-store, sync, time-travel, and barrel surfaces all bundle for the browser. Its durable engine composition is still SQLite-on-Node in practice, because no browser SQL client layer ships here.” Do not shorten that to “the library is browser compatible”: bundling is not running, and every entry in this page's second table is still Node-only.
