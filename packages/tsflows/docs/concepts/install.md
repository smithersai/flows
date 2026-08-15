# Install

`tsflows` expresses dependency installation as one flow with two rounds and three
kinds of action: measure, fetch, and link.

```ts
import { Effect } from "effect"
import { Install, PackageManager } from "@smthrs/tsflows-next"

const program = Install.Install.execute({}).pipe(
  Effect.provide(Install.layer),
  Effect.provide(PackageManager.layerPnpm({
    platform: { os: "linux", arch: "x64", libc: "glibc" }
  })),
  Effect.provide(flowRuntimeLayer),
  Effect.provide(nodeHostLayer)
)
```

The CLI wires the same thing under pnpm. See
[Running targets](../workspace/running-targets.md#installing-dependencies) and
[PnpmWorkspace](../reference/rules/pnpm-workspace.md).

## Two rounds

The flow payload is `{ environment?: Environment }`. It is empty on the first
round.

```
round 1 (environment absent):
  Measure.call({})
    |> andThen((measured) => Install.to({ environment: measured }))

round 2 (environment present):
  Fetch[environment.manager].call({ environment })
    |> andThen((store) => Link.call({ environment, store }))
```

`maxRounds` is 2, and round two never hands off again.

The round split exists for one reason. The package manager is selected by a
layer, so it is unknown while round one is planned. A pure round-one body cannot
inspect a planned value as a JavaScript discriminant and pick one
manager-specific action. A single generic fetch action would have to declare every
supported lockfile in its read set, which would put unrelated lockfiles into the
boundary and the key.

`to` ends round one and carries the measurement into round two as ordinary
payload. The round-two body reads `environment.manager` and names exactly one
fetch action, which reads exactly one lockfile.

## Measure

`Measure` runs `<manager> --version`, digests the manager's lockfile, and digests
`.npmrc` if present.

```ts
Environment = {
  manager: "npm" | "pnpm" | "bun" | "yarn"
  managerVersion: string
  platform: { os, arch, libc } | null
  lockfile: { path, digest }
  npmrc: { path, digest } | null
}
```

It exists as its own action because a lockfile digest is a read of the world, and
the plan phase may not read the world. Moving the read into an action moves it
into the run phase, where it is legal.

Its boundary mode is `expected`, so no cross-run cache ever answers it. Re-measuring
costs one `--version` spawn and two file digests.

## Fetch key material

Round two's payload is hashed inline, so the fetch key folds:

1. **Lockfile digest.** sha256 of the manager's lockfile, paired with its path.
2. **Registry configuration digest.** sha256 of `.npmrc`, after checking that
   credential fields use environment-variable placeholders. A literal token is
   refused, because the hard boundary also hashes the file. The environment
   value is a capability and never enters a key or the journal. `null` when there
   is no `.npmrc`.
3. **Manager identity and exact version.** Measured by running the manager, not
   declared.
4. **Platform**, as `{os, arch, libc}`, when the manager reports
   `platformSensitive`. All three implemented managers do, because optional
   dependencies resolve per platform.

Plus what the engine folds into every key: the action's declaration identity, its
resolved layer set, its capability ceiling, and its declared effects. At dispatch
the scheduler folds the measured read-set digests on top, so the lockfile and
`.npmrc` digests reach the key twice.

The store directory and the project root are not key material. Every
implementation writes to a fixed workspace-relative store, and the engine and
manager both run from the workspace root. Two checkouts at different absolute
paths compute the same fetch key.

## Fetch value and replay

Fetch returns a `StoreManifest`: `{manager, managerVersion, platform, digest}`.
The digest is a sha256 over canonical text built from the key material above. It
is a description, never the store's bytes and never a `node_modules` archive.

Each fetch declares `.flows/store/<manager>` as a `TreeArtifact`. The boundary
records every file below that directory by content digest. A cache hit removes
that store, hydrates the recorded tree, and replays the result. npm and pnpm link
offline, so an incomplete replay fails instead of reaching the registry.

## Link

Link materializes `node_modules` from the already-populated store and returns a
manifest digest, never the tree.

```ts
LinkManifest = { store: Digest, manifest: Digest, linked: boolean }
```

Link always executes and is never restored from another machine. Its boundary
mode is `expected`, and admission requires `hard`.

Its step key still supports local freshness. The implementation keeps a marker at
`node_modules/.flows-link.json` holding the store manifest digest and the
linked-tree manifest digest. The latter folds the store digest, the root
`package.json` digest, and the manager's own evidence about the tree:

| Manager | Evidence digested                          |
| ------- | ------------------------------------------ |
| npm     | `node_modules/.package-lock.json`          |
| pnpm    | `node_modules/.modules.yaml`               |
| Bun     | sorted top-level listing of `node_modules` |

When both digests still match, the action executes but skips the manager command
and reports `linked: false`. The marker is read on this host only, never
published, and treated as absent whenever it fails to parse: a damaged marker
costs one link, not a failure.

Before using either a fresh or a cached store, link rechecks the manager
identity, version, platform, lockfile, and `.npmrc` against the round-one payload,
and rechecks the store manifest against the measured environment. Either mismatch
fails with `environment_mismatch`.

## The manager as a layer

`PackageManager` is a `Context.Service` with one shape and several
implementations. Selecting one is a layer swap.

| Manager | fetch                                                                                   | link                                                                                      |
| ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| pnpm    | `pnpm fetch --store-dir .flows/store/pnpm`                                              | `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir .flows/store/pnpm` |
| npm     | one `npm cache add <resolved-url> --cache .flows/store/npm` per registry tarball        | `npm ci --offline --no-audit --no-fund --ignore-scripts --cache .flows/store/npm`         |
| Bun     | `bun install --frozen-lockfile --ignore-scripts --dry-run --cache-dir .flows/store/bun` | `bun install --frozen-lockfile --ignore-scripts --cache-dir .flows/store/bun`             |
| Yarn    | not implemented                                                                         | not implemented                                                                           |

Constructors: `layerNpm`, `layerPnpm`, `layerBun`, and `layerNoop(name, options)`.
Each takes a `platform` option rather than reading `globalThis.process`, so the
module stays browser-bundleable.

Yarn is named in the `Name` schema and has no implementation.
`layerNoop("yarn", options)` refuses with a typed `unsupported` error. The
abstraction fits Yarn without change: classic Yarn fetches into a mirror and links
a tree, and Yarn PnP fetches into a zip cache and links nothing.

Two implementation notes carry over from `DESIGN.md`. npm has no fetch-only verb,
so its fetch reads resolved tarball URLs out of `package-lock.json`; the parse
decides only what to download, never what to key, and workspace links and
non-HTTP sources are skipped. Bun documents no fetch-only verb and no offline
install flag, so Bun's link can reach the network when the cache is incomplete.
Bun has the weakest replay guarantee of the three.

## Lifecycle scripts

Every command runs with `--ignore-scripts`. Running arbitrary package code is a
different action with a different tier: at least `compensable`, often
`irreversible`, and not sealed by any lockfile digest. Modelling it is deferred
work.

## The store directory

Manager stores stay at `.flows/store/<manager>` and are not controlled by
`cacheDirectory`. Those paths are declared `TreeArtifact` boundaries, and a
declared boundary is key material that must mean the same thing on every machine.
Making store placement configurable requires the boundary to carry the location
as resolved host state rather than as a declared path. `DESIGN.md` records it as
future work.

Discovery and glob expansion always exclude the store, including when the cache
directory is configured elsewhere.

## Next

- [Actions and boundaries](actions-and-boundaries.md)
- [PnpmWorkspace](../reference/rules/pnpm-workspace.md)
- [Remote caching](../workspace/remote-caching.md)
