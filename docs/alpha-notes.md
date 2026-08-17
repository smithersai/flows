# Private alpha notes

Flows release 1 is an engine-group private-alpha pilot: a pre-1.0 durable
execution library for invited operators, not a general-purpose control-plane
release. These notes are the one-page ledger of its shipped posture and limits,
including things a reader would otherwise have to discover from the test tree.
They are statements of current behavior, not promises of planned behavior.

## Support posture

The shipped pilot target is **Node.js 22 with local SQLite**. Package manifests
require Node.js `>=22.19.0`, and CI pins Node `22.19.0`. The durable database
backend is `@effect/sql-sqlite-node`; see the [SQLite operating envelope](pages/sqlite-operating-envelope.md)
before placing a database file on disk.

**PostgreSQL and PGlite are unsupported.** The write-retry seam recognizes
some of their transient failures, but release 1 ships neither a client layer
nor a migration ladder for either backend. This accepted parity gap is tracked
as [issue #78](architecture/implementation-status.md#planned-or-incomplete-integration).

The alpha control server defaults to loopback (`127.0.0.1`). A non-loopback
bind requires the explicit `--listen`/`listen: true` opt-in and does not add
TLS, token rotation, or multi-principal authorization. Keep ordinary alpha
use localhost-only; if an operator opts into a network bind, they must provide
the bearer-token and TLS/ingress protections described in the
[control-plane trust posture](guides/control-plane-trust.md).

## Not in release 1

Release 1 packs the engine group only. The following subsystems exist in this
repository but are not release-1 features: `@smthrs/triggers`,
`@smthrs/evals`, `@smthrs/gateway`, memory semantic recall, and observability
OTLP export. The [implementation-status scope table](architecture/implementation-status.md#not-in-release-1)
explains the status of each; in particular, the published OTLP layer is
application-wired rather than a shipped default.

## Known test pins

A **pin** is a test the default gate does not run to a pass. Three forms count:

- `it.fails` / `test.fails`. The test asserts that current behavior is wrong, so
  the suite goes red on the day it starts passing.
- `.skip` / `.todo`. The test does not execute at all.
- `.skipIf` / `.runIf` on an environment variable nothing in the repo sets. The
  test executes only for someone who remembers it exists.

A `.skipIf` / `.runIf` on a platform, an installed binary, or a built artifact
is a capability gate rather than a pin, because it runs on the supported
configuration. `describe.skipIf(process.platform === "win32")`,
`describe.skipIf(!jjInstalled)` and `describe.skipIf(wasmBytes === undefined)`
are all capability gates, and CI installs `jj`, so the jj-gated suites execute
there. `process.env.CI` is a capability gate for the same reason.

Every pin in the `engine` and `tooling` package groups (`smthrs.group` in each
manifest) must appear in the table below. `scripts/check-test-pins.mjs`
enforces that and CI runs it, so a new pin fails the build until it is either
fixed or written down here.

### Surviving pins

| Package    | Test                                                                                | Form                                      |
| ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `database` | `dies with the original lock defect after the fixed open-retry budget is exhausted` | `it.live.runIf(FLOWS_SLOW_TESTS === "1")` |

**`database` — open-retry exhaustion.** The contract this test encodes is
correct and the test passes: run under `FLOWS_SLOW_TESTS=1` on 2026-08-16 it
exits 0, at 220-240 s over two measurements. It is gated off the default suite
on cost alone. `NodeDatabase.layer` retries a locked open on a fixed ladder —
`openAttempts = 40`, exponential from 5 ms, jittered, capped at 250 ms — that
`NodeDatabaseOptions` deliberately does not expose, because the ladder bounds a
driver-internal race during layer construction, before any service exists to
configure (see the comment on `openSchedule` in
`packages/database/src/node/NodeDatabase.ts`). Against a lock that is never
released, each attempt also blocks inside SQLite's own WAL-conversion wait, so
the real cost is about 6 s per attempt rather than the schedule's delay, and
exhausting the ladder takes roughly four minutes — more than seven times the
package's 30 s per-test budget. What breaks if it regresses: an open that can
never succeed would surface a retry wrapper's error instead of SQLite's own
`database is locked` defect, making a stuck peer harder to diagnose. Workaround
— run it explicitly:

```sh
FLOWS_SLOW_TESTS=1 pnpm --filter @smthrs/database-next test
```

Closing it for the default gate needs either the ladder to become configurable
or the per-attempt SQLite wait to be shortened with a `busy_timeout` on the open
path. Both change production source to suit a test, and neither is an alpha
blocker.

### Resolved: the audit's `it.fails` count

The 2026-08-16 readiness audit recorded finding F4, "`it.fails` pins: 29
remain", distributed across engine-store, flow, kernel, time-travel,
capability, database, harness, jj, platform-node, sync, tsflows-rules and
tsflows-cli. That count was stale at the commit it was filed against. There are
no `it.fails` pins anywhere in `packages/` at `3fcf5fcd`:

```sh
git grep -n 'it\.fails\|test\.fails' -- packages   # no output
```

The last commit carrying any was `c890e65d`, with 12. All 12 were closed by
fixing the defect and flipping the pin, not by deleting the test — each one
still exists as a live assertion in the same file, and each of those suites is
green:

| Package      | Test                                                                                        | Now at                                 |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `canonical`  | has no canonical form for a lone surrogate returned by `toJSON`                             | `test/Canonical.test.ts`               |
| `canonical`  | has no canonical form for a lone surrogate key returned by `toJSON`                         | `test/Canonical.test.ts`               |
| `capability` | bounds wall time for adversarial repeated-star patterns against long non-matching resources | `test/Capability.property.test.ts`     |
| `capability` | completes a 10k-character non-match for a repeated-star grant pattern                       | `test/Capability.test.ts`              |
| `flow`       | normalizes Windows and POSIX separator spellings when comparing overlaps                    | `test/FileBoundary.test.ts`            |
| `flow`       | rejects separator variants of the same written and removed path                             | `test/FileBoundary.test.ts`            |
| `flow`       | rejects a very deep `AndThen` graph with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `flow`       | rejects a cyclic unknown payload with a typed error instead of overflowing the stack        | `test/Graph.test.ts`                   |
| `flow`       | rejects a very deep unknown payload with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `kernel`     | rejects an envelope carrying request-only payload fields                                    | `test/GrantEvent.test.ts`              |
| `kernel`     | fails closed when a page repeats its last sequence with `hasMore`                           | `test/JournalGrantStoreReplay.test.ts` |
| `keys`       | decodes a `key2_` key, which the version marker promises stays readable                     | `test/Key.test.ts`                     |

Agent-group packages are outside this register and outside the guard; F4's
`harness` entry belongs to that group.

## Known limitations

The agent gateway does **not** automatically recover abandoned runs in the
private alpha (audit P1-2). `@smthrs/gateway` exposes the `SuperviseRuntime`
host contract, but its only bundled defaults are `makeNoop` and `layerNoop`:
the default scan returns no candidates and the default resume performs no
work. No production gateway layer connects that contract to the durable
engine's run-driver sweep.

Consequently, a run abandoned by its gateway host is not discovered, reclaimed,
or resumed by the gateway. Operators must recover it explicitly, or use a host
composition that runs the durable engine driver with the relevant flows
registered. Do not rely on unattended gateway recovery for alpha workloads.

This limitation can be retired after a production gateway composition wires
the engine recovery path and a crash-recovery test proves that a stale owner is
reclaimed and the run makes progress automatically.

## Adding a pin

Prefer fixing the defect. If a pin is genuinely the right call:

1. Keep the test executable in some configuration — an env-gated `runIf` beats
   a bare `.skip`, because a skipped test rots silently.
2. Add a comment on the pin pointing at this file.
3. Add a row to **Surviving pins** and a paragraph saying why it is pinned,
   what breaks if the behavior regresses, and the workaround.

`node --test scripts/check-test-pins.test.mjs` enforces step 3. Steps 1 and 2
are review conventions; nothing checks them.
