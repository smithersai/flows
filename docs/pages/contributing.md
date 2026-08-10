# Contributor plan

For people changing the repository rather than using it. Read [Internal details](/internals) for the invariants the durable driver enforces and [Public API tests](/api-tests) for which suite owns which behavior. This page covers the gates, the commit conventions, and the epic plan.

## Setup and gates

Node.js 22.19 or later. `npm install` at the root installs every workspace.

| Gate | Command | What it proves |
| --- | --- | --- |
| typecheck | `npm run check` | every workspace compiles, including `examples` |
| tests | `npm test` | every package suite at 100% coverage over `src/**` |
| lint | `npm run lint` | formatting and lint rules |
| cycles | `npm run circular` | no import cycle inside or across packages |
| entry contract | `npm run browser` | ten entry points bundle for the browser and the Node-only ones still do not |
| examples | `npm run test:examples` | every documented example runs against the real packages |
| docs | `npx vocs build` | the site builds and no page links to a dead route |

`npx vocs dev` serves the site locally.

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
| `api-reference` | one commit per package page, in sidebar order: host, journal, database, kernel, keys, engine, engine-store, plugin, sync, time-travel, then the `@smthrs/flows` barrel | `vocs-scaffold` |
| `internals` | the public API test inventory; observability; internal details; data structures | `api-reference` |
| `architecture` | the mermaid devDependency; the architecture page; package structure | `internals` |
| `narrative` | examples; design decisions; external; this page; the introduction | `architecture` |
| `examples` | one commit per runnable program and its test: define and run, durable run, crash and resume, retry, time-travel fork, time-travel rewind, sync follower, host adapters, browser use | `vocs-scaffold` |
| `readme` | the root README as a one-page contract | `narrative`, `examples` |

### Planned

Each of these closes a gap named in [External](/external). They are listed in dependency order, and none of them has landed.

| Epic | Intended commits | Depends on |
| --- | --- | --- |
| `production-layer` | a `@smthrs/flows` layer composing database, migrations, journal stores, durable deferred and clock state, kernel, host, and engine; a durable getting-started example that survives a restart; the manifest and gate updates | nothing |
| `plugin-dispatch` | dispatch `resolveRetry`, then `classifyError`, then `cacheInconsistency`, then `resolveShareability`, then `waitStart` and `wake`, one seam per commit with a suite proving a plugin changes engine behavior | `production-layer` |
| `supervisor` | `Supervisor.layer` scanning expired leases, due wakes, and `released` rows; a fault case for each scan class | `production-layer` |
| `run-control` | a `RunControl` service journalling attributed pause, cancel, and hijack with actor and reason; the run-row columns; hijack as a plugin over `runControl` | `plugin-dispatch` |
| `quota-park` | a plugin classifying provider quota errors, parking with a wake time, and waking through the durable clock | `plugin-dispatch` |
| `pg-parity` | a `PgDatabase` layer; a `PGliteDatabase` layer; a dialect parameter on `Migrations.run`; the out-of-ladder statements ported; the journal and engine-store suites run against PGlite in CI | nothing |
| `whole-tree-boundary` | a jj-diff-backed `StepBoundary` that attests whole-tree write verification; the first suite proving a cross-run cache hit is correct when granted | nothing |
| `checkpoint` | a `Checkpoint` host capability, layer-gated with a browser noop, invoked only through the `checkpoint` hook; worktree-lane lifecycle | `plugin-dispatch` |
| `continue-as-new` | a `Continued` terminal status closing a parent run; automatic lineage recording from ordinary execution; a restart-lineage fault case | `production-layer` |
| `browser-engine-store` | replace `process.pid` with an identity from a `Random` or crypto layer and `node:crypto` with a platform-neutral source, then move `@smthrs/engine-store` and the barrel into the browser half of the entry matrix | nothing |

## Adding a test

Match the package's existing style: real SQLite through `TestJournal.layer()` or `TestDatabase.layer` rather than a fake store, `Notifying.wrap` for crash and fence-loss injection, and the shared host contract suite rather than a new bespoke adapter assertion.

A behavior that a double cannot prove has to run against the real thing. [Public API tests](/api-tests) lists which behaviors those are and where each one runs today.
