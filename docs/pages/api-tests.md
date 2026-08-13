# Public API tests

What the repository proves about its own public surface, which files prove it, and where the gaps are. Use this page when you change an API and need to know which suite you have just made responsible for the change.

## The gate

Every package runs `vitest` under v8 coverage with 100% thresholds on branches, functions, lines, and statements over `src/**`. Coverage reports go to a per-process directory under the temp dir, because two concurrent runs sharing `./coverage` destroy each other's profiles. Timeouts are 30 seconds and finite, so a genuine hang still fails.

`packages/flows/test/vitestCoverageIsolation.test.ts` is the conformance suite over that arrangement. It pins each package's vitest config, each package's `scripts.test`, the root workspace globs and aggregator scripts, the CI steps that invoke them, the release workflow's pack-and-smoke ordering, and an allowlist of every coverage-ignore directive in any `src` tree with its count.

| Gate | Command |
| --- | --- |
| typecheck | `npm run check` |
| unit and integration tests | `npm test` |
| lint and formatting | `npm run lint` |
| import cycles | `npm run circular` |
| browser and Node entry contract | `npm run browser` |
| runnable examples | `npm run test:examples` |

## Required non-mocked cases

These are the behaviors that have to be exercised against real implementations, because a double would prove nothing about them.

| Behavior | Why a mock cannot prove it | Where it runs |
| --- | --- | --- |
| Transactional commit of state plus lifecycle entry | the guarantee is a property of the SQL transaction | `engine-store/test/WalAtomicity.test.ts` over real SQLite |
| Crash at an interstitial, then restart | a double cannot lose a partial write | `WalAtomicity.test.ts`, `journal/test/Notifying.test.ts` |
| Claim, activate, heartbeat, steal | the compare-and-swap is the database's | `run-store/test/RunStore.test.ts`, `engine-store/test/Ownership.test.ts` |
| Hard-killed owner reclaim | needs the real stale-running sweep | `engine-store/test/HardKillReclaim.test.ts`, `StaleRunningAttempt.test.ts` |
| Cross-connection write races | a single in-process double serializes by accident | `database/test/DatabaseWriteContract.test.ts`, `NodeDatabaseConcurrentOpen.test.ts`, `engine-store/test/CycleDetectionSql.test.ts` |
| Durable schema | DDL and database invariants | `journal/test/Migrations.test.ts` |
| Retry budget across process death | needs persisted attempt rows | `engine-store/test/RetryOrigin.test.ts`, `RetryExpiration.test.ts` |
| Cache admission gating | needs real boundary evidence | `engine-store/test/CacheRecordGating.test.ts`, `CacheAdmissionSerialization.test.ts`, `CacheHitReadSetVerification.test.ts` |
| Replay from persisted attempts | the point is that nothing is in memory | `engine-store/test/Replay.test.ts`, `engine/test/DurableAttemptResume.test.ts` |
| Host adapters against the real machine | a stubbed spawner proves nothing about spawning | `platform-node/test/contract/NodeHost.contract.test.ts`, `jj/test/NodeJj.test.ts` |
| Sync catch-up and follow | needs a real server, client, and journal | `sync/test/Server.test.ts`, `Client.test.ts`, `TransportFaults.test.ts` |
| Rewind archive and truncate | atomicity again | `time-travel/test/Truncation.test.ts`, `Rewind.test.ts`, `RewindRollback.test.ts` |
| Browser entry resolution | only a bundler can answer it | `scripts/browser-check.mjs`, `kernel/test/BrowserBundle.test.ts`, `time-travel/test/BrowserBundle.test.ts` |
| Every documented example program | a doc sample that never runs drifts | `examples/test/*.test.ts` |

## Inventory

| Package | Suites | Notable coverage |
| --- | --- | --- |
| `@smthrs/platform-node-next` | 2 | the shared contract suite (`@smthrs/kernel-next/test/contract`) against the Node bundle, once with explicit expectations and once taking every default |
| `@smthrs/platform-bun-next` | 1 | the same suite against the Bun bundle, which runs the Node fallback under vitest |
| `@smthrs/platform-browser-next` | 5 | the same suite against `BrowserHost`, plus the ZenFS filesystem adapter and the just-bash spawner |
| `@smthrs/jj-next` | 4 | the contract and its no-op, the jj CLI against a real repository, error classification against a scripted binary, and the Bun and browser layers |
| `@smthrs/sandbox-next` | 3 | provider adaptation and cancellation, the scripted test provider, and the deadline-bounded health probe |
| `@smthrs/platform-browser-next` | 4 | the filesystem adapter's operations and bounded streaming against a real directory, the spawner's command rendering, rejected inputs, handle capabilities, and its serialized uninterruptible boundary, and the aggregate layer |
| `@smthrs/journal-next` | 12 | durable and lossy admission, fencing, transactions, retention, redaction, projections, migrations |
| `@smthrs/run-store-next` | 9 | run and attempt stores, ownership arbitration, run metadata, migrations |
| `@smthrs/step-cache-next` | 6 | cache admission, eviction, provenance, migrations |
| `@smthrs/database-next` | 4 | the write-serialization contract, concurrent open, artifact shape |
| `@smthrs/kernel-next` | 23 | capability parsing, matching, subsumption, tiers, ambient sets, grants and their journal persistence, every decorated service |
| `@smthrs/canonical-next` | 1 | RFC 8785 vectors, malformed Unicode, boundary values, and large values |
| `@smthrs/crypto-next` | 1 | injected SHA-256, digest validation, platform failures, and irreversibility |
| `@smthrs/keys-next` | 2 | canonical flow keys and rejected inputs |
| `@smthrs/plan-next` | 6 | the step-key compiler and its collision cases, plan compilation, conflict annotation and append, the append-only store, the node AST, planned-value refusals, build refusals |
| `@smthrs/artifacts-next` | 5 | the store contract, the memory and filesystem implementations, the combined tier, and the remote client |
| `@smthrs/flow-next` | 12 | flow definitions, execution ids, results, suspension, activity combinators and retry pinning, deferreds, clocks, queues, retry policy data, step identity |
| `@smthrs/engine-next` | 18 | activity identity and keys, ordinal stability, keyless concurrency, tiers, durable attempt resume, the memory engine, retry decisions, proxies |
| `@smthrs/engine-store-next` | 61 | the durability matrix: ownership, adoption, sweeps, parking, cancellation, cycles, attempt persistence, cache admission, boundaries, WAL atomicity, fault matrix |
| `@smthrs/sync-next` | 20 | protocol, server paging and workspace merge, client cursors and gaps, transport faults, branch commands, presence, share, projection, convergence |
| `@smthrs/time-travel-next` | 21 | the `TimeTravel` service surface, replay, fork and its lineage, rewind with claims, concurrency and rollback, truncation, compensation, recovery, both stores |
| `@smthrs/flows-next` | 2 | the barrel namespace list against the derived package universe, and the coverage-isolation conformance suite |
| `@smthrs/examples` | 9 | every documentation example, run end to end against the real packages |

## Explicit gaps

These are known and unclosed. None of them is covered by an existing suite.

| Gap | Consequence |
| --- | --- |
| No Postgres or PGlite backend, so the write contract runs on SQLite only | dialect parity is asserted by classification code, not by execution |
| No production whole-tree `StepBoundary`, so no suite exercises a genuine cross-run cache hit | admission is proven to be refused, and never proven to be correct when granted |
| No automatic time-travel record creation from ordinary execution | the protocols are tested against records the suites write by hand |
| No event-driven `resumeSignal` | suspension wake-up is covered through polling and sweeps only |
| No multi-process ownership test spanning real operating-system processes | takeover is covered in-process with injected liveness evidence |
| No Cloudflare or Vercel engine-store deployment | the hosted adapters live in a separate repository and are not gated here |
| No journal checkpointing or compaction | retention is tested; unbounded-history behavior is not |

## Adding a test

Match the package's existing style: real SQLite through `TestJournal.layer()`, `TestStores.layer()`, or `TestDatabase.layer` rather than a fake store, `Notifying.wrap` for crash and fence-loss injection, and the host contract suite rather than a new bespoke adapter assertion. Coverage is already at 100%, so a new branch in `src` without a new case fails the gate rather than passing quietly.
