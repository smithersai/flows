# Package map

This page defines the repository’s package boundaries and actual workspace dependency direction. It is an architecture map, not an API reference; follow each package link for its exported types and functions.

An arrow means “depends on.”

```mermaid
flowchart TD
  H["@smthrs/host"]
  JJ["@smthrs/jj"]
  PTY["@smthrs/pty"]
  SB["@smthrs/sandbox"]
  D["@smthrs/database"]
  C["@smthrs/canonical"]
  Crypto["@smthrs/crypto"]

  J["@smthrs/journal"] --> D
  H --> JJ
  H --> PTY
  SB --> H
  K["@smthrs/kernel"] --> H
  K --> JJ
  K --> PTY
  K --> J
  W["@smthrs/engine"] --> Keys["@smthrs/keys"]
  W --> Crypto
  Keys --> C
  Keys --> Crypto
  E["@smthrs/engine-store"] --> W
  E --> Crypto
  E --> J
  E --> K
  S["@smthrs/sync"] --> J
  T["@smthrs/time-travel"] --> D
  T --> E
  T --> JJ
  T --> J
```

| Package | Responsibility | Important boundary |
| --- | --- | --- |
| [`@smthrs/canonical`](../reference/canonical.md) | RFC 8785 canonical JSON as an Effect Schema | Wraps the standards-focused `canonicalize` library |
| [`@smthrs/crypto`](../reference/crypto.md) | Injected cryptographic schema transformations | Platform implementation is supplied through Effect Crypto |
| [`@smthrs/keys`](../reference/keys.md) | Canonical workflow keys | Composes `canonical` and `crypto` |
| [`@smthrs/database`](../reference/database.md) | `SqlClient` access plus transactional SQLite write retry | Owns no domain tables |
| [`@smthrs/host`](../reference/host.md) | The closed machine-facing service list, the Shell and HttpTransport contracts, and the Node, Bun, browser, and test bundles | Raw effects; no permission decisions |
| [`@smthrs/jj`](../reference/jj.md) | Jujutsu snapshot, restore, diff, and workspace operations | Depends on `effect` alone; the closed Host list still names it |
| [`@smthrs/pty`](../reference/pty.md) | Pseudo-terminal spawn with cursor-replay attach | Depends on `effect` alone; the closed Host list still names it |
| [`@smthrs/sandbox`](../reference/sandbox.md) | Remote-sandbox provider adaptation and sandbox liveness | Adapts a caller's provider onto `host`'s `Shell`; owns no host access |
| [`@smthrs/journal`](../reference/journal.md) | Journal, run ownership, attempts, and cache rows | Open event envelope; SQL-backed state |
| [`@smthrs/engine`](../reference/engine.md) | Vendored Effect flow runtime with flows identity and retry semantics | Computes activity keys above the encoded engine seam |
| [`@smthrs/kernel`](../reference/kernel.md) | Capability sets, grants, and guarded Host decorators | Permission checks occur immediately before Host delegation |
| [`@smthrs/engine-store`](../reference/engine-store.md) | Durable `FlowEngine` implementation over journal stores | Claims runs before driving and fences activity persistence |
| [`@smthrs/sync`](../reference/sync.md) | Read-only journal replication protocol and RPC client/server | It does not mutate runs or journal state |
| [`@smthrs/time-travel`](../reference/time-travel.md) | Replay, fork, rewind, compensation, recovery, and retry utilities | Operates through public journal, cache, `Jj`, and time-travel store contracts |

## Two persistence seams

`@smthrs/journal` owns event rows, run rows, attempt rows, cache rows, and the
migrations for deferred completions and clock deadlines.
`@smthrs/engine-store` adds `DurableEngineState`: `layer` persists those waits
through `Database`, while `layerMemory` remains available for deterministic
tests.

`@smthrs/time-travel` adds audit, receipt, snapshot, lineage-edge, and archive tables through `SqlTimeTravelStore`. Those tables are separate from the journal migration.

## Runtime-specific edges

The core contracts are isomorphic, but not every aggregate is runtime-neutral:

- `@smthrs/engine-store` currently reads `process.pid` and `node:crypto`.
- Platform host adapters (`@smthrs/host-cloudflare`, `@smthrs/host-vercel`) live in the [plugins repository](https://github.com/smithersai/plugins).

See [implementation status](implementation-status.md) and the Cloudflare and Vercel guides in the [plugins repository](https://github.com/smithersai/plugins/blob/main/docs/guides/).
