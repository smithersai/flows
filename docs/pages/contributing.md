# Contributor plan

For people changing the repository rather than using it. Read [Internal details](/internals) for the invariants the durable driver enforces and [Public API tests](/api-tests) for which suite owns which behavior. This page covers the gates, the commit conventions, and the epic plan.

## Setup and gates

Node.js 22.19 or later. `pnpm install` at the root installs every workspace.

| Gate | Command | What it proves |
| --- | --- | --- |
| typecheck | `pnpm run check` | every workspace compiles, including `examples` |
| tests | `pnpm test` | every package suite at 100% coverage over `src/**` |
| lint | `pnpm run lint` | formatting and lint rules |
| cycles | `pnpm run circular` | no import cycle inside or across packages |
| entry contract | `pnpm run browser` | ten entry points bundle for the browser and the Node-only ones still do not |
| examples | `pnpm run test:examples` | every documented example runs against the real packages |
| docs | `pnpm exec vocs build` | the site builds and no page links to a dead route |

`pnpm exec vocs dev` serves the site locally.

All seven run before a pull request. Coverage thresholds are absolute, so a new branch in `src` without a new case fails the gate rather than passing quietly.

## Where code goes

New modules under `packages/` mirror the Effect repository: file structure, module layout, `make`, `makeNoop`, `layer`, and `layerNoop` naming, error conventions, and `@since` and `@category` JSDoc. Open the corresponding Effect file and copy its shape rather than inventing a convention.

Two rules are specific to this tree. Host access goes through a layer, always, so a package root exports contracts and every platform implementation lives under a `/node`, `/bun`, `/browser`, or `/test` subpath. And in Effect generators, bind a service to a named variable before calling its methods; no nested service yields.

## Writing docs

Docs sources under `docs/pages` are the Vocs site. There is no second copy: a page is a page, and prose that belongs in one lives there rather than being duplicated into a README.

Concept and guide prose uses conversational you, asks the question a reader would ask, and moves from simple to precise. Reference prose is terse, code-first, and table-heavy. Say Implemented only for behavior that exists in `packages/*/src` with a test; call contract and TODO behavior Planned.

Six things do not appear in these pages. The em dash character, replaced by a comma, a colon, or a full stop. The antithesis that negates one description to assert another. Hedging adverbs that soften a claim without qualifying it. Decorative triads written for rhythm rather than for a third fact. Marketing intensifiers, which say nothing a benchmark or a table would not say better. And bullets that open with a bold label and a colon, which is a table pretending to be prose.

## Commit conventions

Small atomic emoji conventional commits, grouped by epic. One docs page per commit. One example plus its test wiring per commit. Package-manifest changes carry their lockfile change in the same commit.

Every commit body carries a `Docs:` trailer naming the docs files it touches or is documented by. Every commit except the first of a series carries `Depends-on:` with the short SHAs of the prior commits in that series.

```
📝 docs(architecture): add the architecture page and its system diagram

Docs: docs/pages/architecture.md
Depends-on: 5973042, 8534b67
```

Use explicit pathspecs for every commit. Do not use `git add -A`, `git commit -a`, `git stash`, or `git commit --amend` on someone else's work. If your own earlier commit in the current series is wrong, rewrite or squash the fix into it rather than appending a follow-up.

## Epic plan

### Landed

| Epic | Commits | Depends on |
| --- | --- | --- |
| `vocs-scaffold` | the Vocs devDependency and `vocs.config.ts`; the sidebar in reading order; the package barrel export docs | nothing |
| `api-reference` | one commit per package page, in sidebar order: host, journal, database, kernel, keys, engine, engine-store, sync, time-travel, then the `@smthrs/flows-next` barrel | `vocs-scaffold` |
| `internals` | the public API test inventory; observability; internal details; data structures | `api-reference` |
| `architecture` | the mermaid devDependency; the architecture page; package structure | `internals` |
| `narrative` | examples; design decisions; external; this page; the introduction | `architecture` |
| `examples` | one commit per runnable program and its test: define and run, durable run, crash and resume, retry, time-travel fork, time-travel rewind, sync follower, host adapters, browser use | `vocs-scaffold` |
| `readme` | the root README as a one-page contract | `narrative`, `examples` |

### Planned

Each of these closes a gap named in [External](/external). They are listed in dependency order. None has landed in full; `production-layer` has landed in part, as noted in its row.

| Epic | Intended commits | Depends on |
| --- | --- | --- |
| `production-layer` | a `@smthrs/flows-next` layer composing database, migrations, journal stores, durable deferred and clock state, kernel, a platform bundle, and engine; a durable getting-started example that survives a restart; the manifest and gate updates. **Partly landed:** the `NodeRuntime` subpath packages the storage and engine composition and the durable example builds on it; still open are the kernel and platform-bundle half — `NodeRuntime` installs neither `NodeHost.layer` nor the guarded `HostServices` kernel — and a package-level gate for the module | nothing |
| `injectable-seams` | put a service or a defaulted option in front of `resolveRetry`, then `classifyError`, then `resolveShareability`, then `waitStart` and `wake`, one seam per commit with a suite proving a provided `Layer` changes engine behavior | `production-layer` |
| ~~`supervisor`~~ | **Withdrawn.** The run driver's heartbeat-cadence sweep handles `released` and cancel-requested parked rows plus stale `running` rows; no separate `Supervisor.layer` is planned — see [gap 8](https://github.com/smithersai/flows/blob/main/docs/architecture/smithers-replacement-gaps.md#8-supervisor-sweep--closed-inside-the-run-driver). Durable clocks are instead re-armed by `DeferredPersistence.sweepDue` during flow registration and fire through per-clock timer fibers. A gateway supervisor that launches a process for an abandoned run is a distinct, still-unplanned piece of work | — |
| `run-control` | a `RunControl` service journalling attributed pause, cancel, and hijack with actor and reason; the run-row columns; hijack as an alternative `RunControl` implementation | `injectable-seams` |
| `quota-park` | an error-classification service that recognizes provider quota errors, parks with a wake time, and wakes through the durable clock | `injectable-seams` |
| `pg-parity` | a `PgDatabase` layer; a `PGliteDatabase` layer; a dialect parameter on `Migrations.run`; the out-of-ladder statements ported; the journal and engine-store suites run against PGlite in CI | nothing |
| `whole-tree-boundary` | a jj-diff-backed `StepBoundary` that attests whole-tree write verification; the first suite proving a cross-run cache hit is correct when granted | nothing |
| `checkpoint` | a `Checkpoint` host capability, layer-gated with a browser noop; worktree-lane lifecycle | `injectable-seams` |
| `continue-as-new` | a `Continued` terminal status closing a parent run; automatic lineage recording from ordinary execution; a restart-lineage fault case | `production-layer` |
| `browser-sql-client` | a `DurableWriter`-backing SQL client layer for the browser, so the durable engine can *run* where it already bundles | nothing |

## Adding a test

Match the package's existing style: real SQLite through `TestJournal.layer()` or `TestDatabase.layer` rather than a fake store, `Notifying.wrap` for crash and fence-loss injection, and the shared host contract suite rather than a new bespoke adapter assertion.

A behavior that a double cannot prove has to run against the real thing. [Public API tests](/api-tests) lists which behaviors those are and where each one runs today.
