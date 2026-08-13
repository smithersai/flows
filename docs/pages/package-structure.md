# Package structure

Twenty-three npm workspaces under `packages/`, one closed dependency set. This page is the map: who owns which data, which package may import which, and which entry points bundle for a browser.

## Workspaces

| Workspace | Directory | Published | Owns |
| --- | --- | --- | --- |
| `@smthrs/flows-next` | `packages/flows` | yes | nothing; re-exports the engine packages below as namespaces — but not the `platform-*` bundles |
| `@smthrs/jj-next` | `packages/jj` | yes | no tables; the `Jj` contract, `JjError`, and its adapters |
| `@smthrs/sandbox-next` | `packages/sandbox` | yes | no tables; remote process execution and the health probe |
| `@smthrs/platform-browser-next` | `packages/platform-browser` | yes | no tables; browser `FileSystem` and `ChildProcessSpawner` implementations, and the `BrowserHost` bundle |
| `@smthrs/platform-node-next` | `packages/platform-node` | yes | no tables; the `NodeHost` bundle over Effect's own Node adapters |
| `@smthrs/platform-bun-next` | `packages/platform-bun` | yes | no tables; the Bun filesystem and the `BunHost` bundle |
| `@smthrs/journal-next` | `packages/journal` | yes | `flows_journal_events`, `flows_journal_checkpoints` |
| `@smthrs/run-store-next` | `packages/run-store` | yes | `flows_runs`, `flows_attempts` |
| `@smthrs/step-cache-next` | `packages/step-cache` | yes | `flows_step_cache` |
| `@smthrs/database-next` | `packages/database` | yes | no tables; the `SqlClient` contract and write retry |
| `@smthrs/capability-next` | `packages/capability` | yes | no tables; the capability vocabulary and typed permission failures, with their journaled schema ids |
| `@smthrs/kernel-next` | `packages/kernel` | yes | the closed host service list, capability sets, grants, and their journal records |
| `@smthrs/canonical-next` | `packages/canonical` | yes | no tables; RFC 8785 canonical JSON |
| `@smthrs/crypto-next` | `packages/crypto` | yes | no tables; injected cryptographic operations |
| `@smthrs/keys-next` | `packages/keys` | yes | no tables; canonical flow keys |
| `@smthrs/plan-next` | `packages/plan` | yes | `flows_plans`, `flows_plan_nodes`, `flows_plan_edges` |
| `@smthrs/artifacts-next` | `packages/artifacts` | yes | no tables; bytes addressed by their own SHA-256 digest |
| `@smthrs/flow-next` | `packages/flow` | yes | no tables; flow, activity, and durable-primitive definitions plus the runtime port |
| `@smthrs/engine-next` | `packages/engine` | yes | no tables; the engine that executes them, and the RPC/HTTP façades |
| `@smthrs/engine-store-next` | `packages/engine-store` | yes | `flows_deferred_completions`, `flows_clock_deadlines`, `flows_run_parents` |
| `@smthrs/sync-next` | `packages/sync` | yes | no tables; a wire protocol over journal entries |
| `@smthrs/time-travel-next` | `packages/time-travel` | yes | `flows_time_travel_snapshots`, `_edges`, `_audits`, `_receipts`, `_archive` |
| `@smthrs/observability-next` | `packages/observability` | yes | no tables; the default OTLP exporter layer over Effect's own observability modules |
| `@smthrs/examples` | `examples` | no | the runnable example suite |

Every published manifest is `0.1.0`, every internal production range is an exact `0.1.0`, and `effect` is pinned to exact `4.0.0-rc.108`.

## Who owns which data

Six packages create schema, in three different ways. Knowing which is which keeps a table in its owning package.

| Owner | Mechanism | Tables |
| --- | --- | --- |
| `@smthrs/journal-next` | `0001_initial` and `0002_checkpoints`, run by `Migrations.layer` | `flows_journal_events`, `flows_journal_checkpoints` |
| `@smthrs/run-store-next` | `0001_initial`, run by `Migrations.layer` | `flows_runs`, `flows_attempts` |
| `@smthrs/step-cache-next` | `0001_initial`, run by `Migrations.layer` | `flows_step_cache` |
| `@smthrs/plan-next` | `0001_initial`, run by `Migrations.layer`; append-only triggers created with the tables | `flows_plans`, `flows_plan_nodes`, `flows_plan_edges` |
| `@smthrs/engine-store-next` | `0001_initial`; its `Migrations.layer` composes the journal, run-store, step-cache, and plan sets with its own, plan's last | `flows_deferred_completions`, `flows_clock_deadlines` |
| `@smthrs/engine-store-next` | statements issued by `DurableEngineState.make` at construction | `flows_run_parents`, its index, the `flows_run_parents_gc` trigger, the stale-running partial index |
| `@smthrs/time-travel-next` | `SqlTimeTravelStore.migrate` | snapshots, lineage edges, audits, receipts, archive |

Each storage package exports its migration set from its own `Migrations` module, and `@smthrs/database-next`'s `Migrations` composes them over one `flows_migrations` table: a set declares a `namespace` that prefixes its migration names and an `idOffset` that reserves a block of migration ids, so two packages' `0001_initial` land on distinct identities and a mis-declared package fails the migration instead of silently shadowing a table. The blocks are journal `0`, run store `1000`, step cache `2000`, engine store `3000`, and plan `4000`. `@smthrs/engine-store-next/Migrations` is the composed list an engine installs, and it puts the plan set last because a `Migrator` decides what to run from a single high-water mark, so a set whose ids sit below an already-applied one would be assumed done.

The engine-store statements sit outside its migration deliberately, because the package creates them when its layer is built. They are inventoried in `packages/engine-store/src/internal/EngineStateSchema.ts` with the dialects each one is known to accept, and a catalog-diff test fails when new DDL appears without an inventory entry.

## Dependency graph

An arrow means the left package imports the right one.

```mermaid
flowchart LR
  FLOWS["@smthrs/flows-next"]
  TT["@smthrs/time-travel-next"]
  ES["@smthrs/engine-store-next"]
  SYNC["@smthrs/sync-next"]
  KERNEL["@smthrs/kernel-next"]
  FLOW["@smthrs/flow-next"]
  ENGINE["@smthrs/engine-next"]
  JOURNAL["@smthrs/journal-next"]
  RUNSTORE["@smthrs/run-store-next"]
  STEPCACHE["@smthrs/step-cache-next"]
  DB["@smthrs/database-next"]
  JJ["@smthrs/jj-next"]
  SANDBOX["@smthrs/sandbox-next"]
  PB["@smthrs/platform-browser-next"]
  PN["@smthrs/platform-node-next"]
  PBUN["@smthrs/platform-bun-next"]
  KEYS["@smthrs/keys-next"]
  PLAN["@smthrs/plan-next"]
  ART["@smthrs/artifacts-next"]
  CRYPTO["@smthrs/crypto-next"]
  CANONICAL["@smthrs/canonical-next"]
  CAP["@smthrs/capability-next"]
  OBS["@smthrs/observability-next"]

  KERNEL --> CAP
  JJ --> CAP
  FLOWS --> CAP

  FLOWS --> JJ
  FLOWS --> SANDBOX
  FLOWS --> DB
  FLOWS --> JOURNAL
  FLOWS --> RUNSTORE
  FLOWS --> STEPCACHE
  FLOWS --> KERNEL
  FLOWS --> KEYS
  FLOWS --> PLAN
  FLOWS --> ART
  FLOWS --> CRYPTO
  FLOWS --> CANONICAL
  FLOWS --> FLOW
  FLOWS --> ENGINE
  FLOWS --> ES
  FLOWS --> SYNC
  FLOWS --> TT
  JOURNAL --> DB
  RUNSTORE --> DB
  RUNSTORE --> JOURNAL
  STEPCACHE --> DB
  STEPCACHE --> CANONICAL
  SANDBOX --> KERNEL
  KERNEL --> JJ
  KERNEL --> PB
  KERNEL --> JOURNAL
  PB --> KERNEL
  PB --> JJ
  PN --> KERNEL
  PN --> JJ
  PBUN --> KERNEL
  PBUN --> JJ
  FLOW --> KEYS
  FLOW --> CRYPTO
  FLOW --> PLAN
  ENGINE --> FLOW
  ENGINE --> KEYS
  KEYS --> CANONICAL
  KEYS --> CRYPTO
  PLAN --> DB
  PLAN --> KEYS
  ART --> CRYPTO
  ES --> FLOW
  ES --> ENGINE
  ES --> CRYPTO
  ES --> DB
  ES --> KEYS
  ES --> PLAN
  ES --> ART
  ES --> JOURNAL
  ES --> RUNSTORE
  ES --> STEPCACHE
  ES --> KERNEL
  SYNC --> JOURNAL
  TT --> DB
  TT --> ES
  TT --> JJ
  TT --> JOURNAL
  TT --> RUNSTORE
  TT --> STEPCACHE
```

| Package | Depends on | Depended on by |
| --- | --- | --- |
| `@smthrs/canonical-next` | nothing in the workspace | `keys`, `step-cache`, `flows` |
| `@smthrs/crypto-next` | nothing in the workspace | `artifacts`, `keys`, `flow`, `engine-store`, `flows` |
| `@smthrs/keys-next` | `canonical`, `crypto` | `plan`, `flow`, `engine`, `engine-store`, `flows` |
| `@smthrs/capability-next` | nothing in the workspace | `jj`, `kernel`, `flows` |
| `@smthrs/jj-next` | `capability` | `kernel`, `platform-*`, `time-travel`, `flows` |
| `@smthrs/platform-browser-next` | `jj`, `kernel` | `kernel` (test bundle only) |
| `@smthrs/platform-node-next` | `jj`, `kernel` | nothing |
| `@smthrs/platform-bun-next` | `jj`, `kernel` | nothing |
| `@smthrs/sandbox-next` | `kernel` | `flows` |
| `@smthrs/artifacts-next` | `crypto` | `engine-store`, `flows` |
| `@smthrs/database-next` | nothing in the workspace | `journal`, `run-store`, `step-cache`, `plan`, `engine-store`, `time-travel`, `flows` |
| `@smthrs/journal-next` | `database` | `kernel`, `run-store`, `engine-store`, `sync`, `time-travel`, `flows` |
| `@smthrs/run-store-next` | `database`, `journal` | `engine-store`, `time-travel`, `flows` |
| `@smthrs/step-cache-next` | `canonical`, `database` | `engine-store`, `time-travel`, `flows` |
| `@smthrs/kernel-next` | `capability`, `jj`, `journal`, `platform-browser` | `engine-store`, `platform-*`, `sandbox`, `flows` |
| `@smthrs/plan-next` | `database`, `keys` | `flow`, `engine-store`, `flows` |
| `@smthrs/flow-next` | `crypto`, `keys`, `plan` | `engine`, `engine-store`, `flows` |
| `@smthrs/engine-next` | `flow`, `keys` | `engine-store`, `flows` |
| `@smthrs/engine-store-next` | `artifacts`, `crypto`, `database`, `engine`, `flow`, `journal`, `kernel`, `keys`, `plan`, `run-store`, `step-cache` | `time-travel`, `flows` |
| `@smthrs/sync-next` | `journal` | `flows` |
| `@smthrs/time-travel-next` | `database`, `engine-store`, `jj`, `journal`, `run-store`, `step-cache` | `flows` |
| `@smthrs/observability-next` | nothing in the workspace | nothing; an application composes it beside the engine, the way it composes a `platform-*` bundle |
| `@smthrs/flows-next` | every package except the three `platform-*` bundles | nothing |

`npm run circular` fails the build on an import cycle, within a package or across them.

The one cycle at *package* granularity is `kernel` ↔ `platform-browser`: the kernel's deterministic `TestHost` bundle (a test-only subpath) mounts the browser filesystem and interpreter, and `BrowserChildProcessSpawner` renders command lines with the kernel's `CommandLine`. Removing `HttpTransport` cut the network half of it — `BrowserHost` now provides Effect's own `HttpClient` and no longer fills a kernel-owned slot. No module-level cycle exists, which is what `npm run circular` checks.

## Entry point matrix

A package root exports contracts. A platform implementation lives under a subpath named for its platform, the way `effect` keeps `@effect/platform-node` out of `effect`. A root that re-exports an implementation resolves that implementation's imports for every consumer, including browser ones, before any bundler can tree-shake it.

`scripts/browser-check.mjs` executes this table. It bundles each browser entry point with esbuild `platform: "browser"` and fails if one breaks, and it bundles each Node entry point and fails if one stops failing. `npm run browser` runs it locally and CI runs it as a step.

| Entry point | Browser | Node | Why |
| --- | --- | --- | --- |
| `@smthrs/platform-browser-next` | yes | yes | browser `FileSystem` and `ChildProcessSpawner`, and the `BrowserHost` bundle over effect's own fetch `HttpClient` |
| `@smthrs/platform-browser-next/BrowserHost` | yes | yes | `layer({ bash, fs, jj })` over an injected browser filesystem, interpreter, and compiled `flows_jj.wasm`; all five tags real |
| `@smthrs/platform-node-next` | no | yes | child processes, Node filesystem, Jujutsu |
| `@smthrs/platform-bun-next` | no | yes | the Bun adapters, falling back to `@effect/platform-node` off Bun |
| `@smthrs/kernel-next/test/TestHost` | no | yes | `effect/testing`'s `TestClock` imports `node:assert` |
| `@smthrs/jj-next` | yes | yes | the `Jj` contract, `JjError`, and the no-op layer |
| `@smthrs/jj-next/browser/BrowserJj` | yes | yes | jj-lib as `wasm32-wasip1` over an injected virtual filesystem; `layerUnsupported` is the no-module fallback |
| `@smthrs/jj-next/node/NodeJj`, `@smthrs/jj-next/bun/BunJj` | no | yes | spawn the jj CLI through `node:child_process` |
| `@smthrs/sandbox-next` | yes | yes | provider adaptation and the liveness probe; no host access of its own |
| `@smthrs/capability-next` | yes | yes | capability vocabulary and typed permission failures |
| `@smthrs/kernel-next` | yes | yes | capabilities, grants, decorated services |
| `@smthrs/canonical-next` | yes | yes | RFC 8785 canonical JSON schema |
| `@smthrs/crypto-next` | yes | yes | injected cryptographic schemas |
| `@smthrs/keys-next` | yes | yes | canonical flow-key schema |
| `@smthrs/plan-next` | yes | yes | plan compilation, the authoring AST, the diff, and the plan store over the `DurableWriter` contract |
| `@smthrs/artifacts-next` | yes | yes | the content-addressed artifact store, local and remote |
| `@smthrs/database-next` | yes | yes | the driver-neutral contract only |
| `@smthrs/database-next/node/NodeDatabase` | no | yes | `node:sqlite` through `@effect/sql-sqlite-node` |
| `@smthrs/database-next/test/TestDatabase` | no | yes | in-memory SQLite through the same driver |
| `@smthrs/journal-next` | yes | yes | the journal and its migration over `SqlClient` and the `DurableWriter` contract |
| `@smthrs/journal-next/test/TestJournal` | no | yes | composes `TestDatabase` |
| `@smthrs/run-store-next` | yes | yes | run and attempt stores over the same contracts |
| `@smthrs/run-store-next/test/TestRunStore` | no | yes | composes `TestDatabase` |
| `@smthrs/step-cache-next` | yes | yes | the step cache over the same contracts |
| `@smthrs/step-cache-next/test/TestCacheStore` | no | yes | composes `TestDatabase` |
| `@smthrs/flow-next` | yes | yes | flow, activity, durable primitives, retry, identity |
| `@smthrs/engine-next` | yes | yes | the engine that executes flows, plus the RPC/HTTP façades |
| `@smthrs/engine-store-next` | yes | yes | the durable engine; owner identity enters through `OwnerIdentity` |
| `@smthrs/sync-next` | yes | yes | protocol and client and server over RPC |
| `@smthrs/time-travel-next` | yes | yes | frames, replay, fork, rewind, compensation, recovery |
| `@smthrs/observability-next` | yes | yes | OTLP logs, metrics, and traces layers over Effect's `HttpClient`; the fetch variant binds the host's global `fetch` |
| `@smthrs/flows-next` | yes | yes | re-exports every engine package |

Twenty-three entry points bundle for the browser. Bundling is a weaker claim than running: `@smthrs/journal-next`, `@smthrs/run-store-next`, `@smthrs/step-cache-next`, and `@smthrs/plan-next` bundle because they depend on the `DurableWriter` contract, and a browser application still has to supply a browser SQL client, such as Effect's sqlite-wasm OPFS worker, to that contract. No such layer ships here.

The accurate sentence is that canonical JSON, crypto, the host contracts, `BrowserHost`, keys, plan, artifacts, capability, kernel, sandbox, database, journal, run store, step cache, flow, engine, engine-store, the barrel, sync, time travel, and the OTLP exporter bundle for the browser, and the durable engine composition is still SQLite-on-Node first because no browser SQL client layer ships here. `@smthrs/engine-store-next`'s last two `node:`-flavoured reads — `process.pid` and `node:crypto` `randomUUID` — moved behind the `OwnerIdentity` service, which closed issue #114.

## Build shape

Every published package builds a dual module surface: `dist/esm/index.js`, `dist/esm/index.d.ts`, and `dist/cjs/index.js`, named by a conditional `publishConfig.exports` map with `./internal/*` blocked. `scripts/pack-release.mjs` packs and publishes all twenty-three publishable workspaces from one dependency-ordered list, so a package cannot be published before something it depends on. Every package ships a byte-identical `LICENSE` in its `files` whitelist. `packages/flow` and `packages/engine` additionally ship `THIRD_PARTY_NOTICES.md`, because they carry the two halves of a fork of Effect's unstable workflow surface; `packages/engine` also ships the `VENDOR.md` that records the fork for both.

New package modules mirror the Effect repository: file structure, module layout, `make` and `layer` naming, error conventions, and `@since` and `@category` JSDoc.

## Reading next

[Public API](/api/flows) enumerates the exports of each package. [Internal details](/internals) covers the invariants the engine-store owns. [External](/external) states what a deployment cannot do yet.
