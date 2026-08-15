# tsflows: dependency installation as flows

`@smthrs/tsflows-next` expresses package installation as a flow. It splits installation into a
sealed, shareable fetch and an unshareable link, keys the fetch by content, and
puts its result in the cache the flows repo already ships. It never caches
`node_modules` as a file artifact.

This document records the prior art that shaped the design, the design itself,
how it uses the existing cache, the Postgres model for self-hosting the shared
tier, and every place the design departs from a source.

## 1. Prior art

### 1.1 What I inspected, and what is prior knowledge

I read these files in this repository:

- `docs/specs/Concepts/Unified Flow Authoring.md`, `Step Keys.md`,
  `Remote Cache.md`, `Build Phases.md`, `Vendored Workflow Engine.md`, and
  `docs/specs/Specs/Object Model.md`.
- `flows/packages/flow/src/Flow/Flow.ts`, `Flow/make.ts`, `Flow/Outcome.ts`,
  `Action/Action.ts`, `Action/make.ts`, `Action/FileInput.ts`,
  `Action/FileBoundary.ts`, `Action/BoundaryMode.ts`,
  `Action/CacheEnvironment.ts`, `Action/StepIdentity.ts`,
  `Flow/Annotations.ts`, `Graph.ts`, and `flows/packages/plan/src/Node.ts`,
  `Plan.ts`, `StepKey.ts`, `KeyMaterial.ts`, and `FileSet.ts`.
- `flows/packages/flow/test/ActionDeclared.test.ts`,
  `test/FlowAuthoring.test.ts`, and `test/Trampoline.test.ts`, plus the
  annotation cases in `test/Graph.test.ts`.
- `flows/packages/step-cache/src/CacheStore.ts`, `RemoteCacheStore.ts`,
  `migrations/0001_initial.ts`, `flows/packages/artifacts/src/ArtifactStore.ts`
  and `RemoteArtifacts.ts`, and `flows/packages/engine-store/src/PlanScheduler.ts`
  around action dispatch.
- `reference/bazel/src/main/java/com/google/devtools/build/skyframe/`: the
  directory listing (86 files), `FunctionHermeticity.java`,
  `MemoizingEvaluator.java`, `NodeEntry.java`, and `IntVersion.java`.
- Package metadata and TypeScript configuration for `@smthrs/flow-next`,
  `@smthrs/plan-next`, and `effect@4.0.0-rc.108`, and the external type
  declarations for `effect/FileSystem`, `effect/unstable/process/ChildProcess`,
  and `effect/unstable/process/ChildProcessSpawner`.
- `reference/effect/packages/effect/package.json` and `tsconfig.json`, plus the
  flows package's `package.json`, build scripts, lint configuration, and
  TypeScript configuration.
- Local package-manager help output: `pnpm fetch --help`, `npm cache add --help`,
  `bun install --help`, and `bun pm --help`.

Everything said below about rules_js, rules_nodejs, turborepo, nx, Yarn Plug'n'Play,
and CI install caching is **general prior knowledge, not inspection**. Those
repositories are not on the shelf in `reference/`, and I did not fetch them.
Where a claim matters to a decision, I say what the decision would be if the
claim is wrong.

### 1.2 Skyframe (inspected)

Skyframe is a keyed, memoizing, incremental evaluator: `MemoizingEvaluator`
computes values from keys, functions declare dependencies on other keys, and
"the graph caches previously computed values" so that invalidation is a graph
operation rather than a timestamp comparison. Three details shaped this design.

`FunctionHermeticity` grades functions `HERMETIC`, `SEMI_HERMETIC`, and
`NONHERMETIC`, and its comment states the reason plainly: a non-hermetic
function reads state Skyframe does not track, so "such a node may be explicitly
dirtied due to outside changes". That supports the fetch/link split. Fetching
is sealed by declared lockfile, configuration, manager, and platform inputs.
Linking depends on host-local filesystem and symlink behavior, so it executes
locally even after the store is restored.

`NodeEntry.LifecycleState` names `VERIFIED_CLEAN`: dependencies were checked,
nothing changed, and the node is not rebuilt. That is change pruning on
dependency _values_. flows follows the same rule at dispatch.
`StepKey.dispatchIdentity` folds the digest of each settled upstream result,
not the upstream plan key. The plan key still identifies static topology.

`IntVersion` is a monotone integer version rather than a content hash. flows
went the other way, and `docs/specs/Concepts/Step Keys.md` explains why:
content addressing is what makes sharing across machines possible at all. The
design here follows flows, not Skyframe, on that point.

### 1.3 rules_js (prior knowledge)

rules_js splits `npm_translate_lock` from the per-package `npm_import` targets.
The lockfile is translated once into a set of individually addressed downloads,
each package becomes its own repository rule keyed by name, version, and
integrity, and the tree a target sees is a symlink farm assembled by Bazel
rather than by npm.

What it gets right: fetching is per-package and integrity-keyed, so editing one
dependency invalidates one download; the pnpm-layout tree is materialized for
the consuming sandbox instead of transported as a monolithic `node_modules`
archive; and lifecycle scripts are separate, explicitly enumerated targets
rather than an ambient side effect of installing.

What is wrong for us: the granularity has a price the task defers. Per-package
keying requires parsing every supported lockfile format faithfully, which is a
maintenance surface tsflows does not want in its first version. rules_js also
owns tree construction. tsflows leaves tree construction to the manager,
because a coding-agent harness has to produce a tree that the user's own
`npm run` respects.

### 1.4 rules_nodejs (prior knowledge, deprecated)

The older `build_bazel_rules_nodejs` ran `npm install` or `yarn install` in a
repository rule. It generated one external repository for the complete
dependency graph and exposed that repository to Bazel targets.

What it gets right: it made dependency installation reproducible from a
lockfile and kept one install from running for every build action.

What it gets wrong for this design: the repository rule is a coarse unit. One
lockfile change invalidates the generated repository. Package fetches,
lifecycle scripts, and tree construction remain one operation outside the
ordinary action graph. rules_js replaced that model with per-package fetches
and explicit lifecycle actions. `tsflows` follows the newer split and does not
publish the installed tree.

### 1.5 turborepo (prior knowledge)

Turborepo hashes task inputs, including the lockfile and the workspace's
dependency closure, and caches task _outputs_ locally and through a remote
cache with a simple HTTP protocol.

What it gets right: content hashing over the lockfile closure, and treating the
remote cache as an accelerator that never blocks a build.

What it gets wrong for this design: it treats installation as outside the graph.
`turbo` expects dependencies to already exist, so the install has no task key,
cache record, or graph explanation. tsflows puts installation inside the graph.

### 1.6 nx (prior knowledge)

Nx computes a project graph, hashes task inputs including lockfile hashes, and
caches task outputs locally or remotely.

What it gets right: the project graph is derived and cached rather than
declared by hand, and lockfile hashing is treated as a first-class input.

What it gets wrong for this design: like turborepo, installation is a
precondition rather than a node, and Nx's cache restores output directories.
Restoring directories is right for `dist/`, and wrong for `node_modules/`.

### 1.7 Yarn Plug'n'Play (prior knowledge)

Yarn PnP removes the link phase. Packages stay as zip archives in a cache
directory, and a runtime resolver maps requests to entries inside them.

What it gets right: it is the strongest possible statement of this design's
thesis. If linking is what cannot be shared, delete linking. A PnP project's
install reduces to fetch plus a small resolution file.

What it gets wrong for us: it changes the runtime contract. Tools that stat
`node_modules` break without the compatibility layer, and a coding-agent
harness cannot impose that on a user's repository. tsflows therefore keeps
link, and treats PnP as the degenerate case: `fetch` runs, `link` does nothing
but produce a manifest digest of the resolution artifacts.

### 1.8 CI install caches (prior knowledge)

The common CI pattern caches the manager's cache directory (`~/.npm`,
the pnpm store, `~/.bun/install/cache`) keyed on a lockfile hash, then runs
`npm ci` or `pnpm install --frozen-lockfile` on every job. A less careful
variant caches `node_modules` directly.

What the common pattern gets right: it caches the store, not the tree, and it
keys on the lockfile. That is the same split this design formalizes.

What it gets wrong: the cache key usually omits the manager version, the
platform, and the registry configuration, so a runner-image upgrade or an
`.npmrc` change silently reuses the wrong store. The restore is also a tarball
of a directory rather than content-addressed entries, so it degrades to
"download everything or nothing". The `node_modules` variant is worse: it
produces trees whose absolute paths and prebuilt binaries do not match the
machine that restored them.

## 2. The design

### 2.1 Nouns

Six Action declarations and one Flow. Four manager-specific declarations form
one logical fetch operation. Separate declarations keep each hard boundary's
read set to the selected lockfile. In the shipped API the atom is spelled
`Action`, not `Activity`; section 7 records that discrepancy.

| Noun                 | Name                              | Kind   | Round | Tier           | Boundary       | Cache-admissible              |
| -------------------- | --------------------------------- | ------ | ----- | -------------- | -------------- | ----------------------------- |
| Measure inputs       | `tsflows/install/measure`         | Action | 1     | `sealed`       | `expected`     | no                            |
| Fetch into the store | `tsflows/install/fetch/{manager}` | Action | 2     | `sealed`       | `hard`         | yes, with whole-tree evidence |
| Link the tree        | `tsflows/install/link`            | Action | 2     | `sealed`       | `expected`     | no                            |
| The install          | `tsflows/install`                 | Flow   | both  | not applicable | not applicable | not applicable                |

Every tier reads `sealed` because the shipped plan compiler accepts nothing
else. `StepKey.fromKeyMaterial` fails with `non_content_material` for
`compensable` and `irreversible` key material, and `Plan.compile` calls it for
every node, so one `compensable` Action makes the whole flow unplannable. This
was measured, not assumed: with `Link` declared `compensable`, `Plan.compile`
rejects the install plan. Section 7 records the gap. What actually keeps a
result out of the cross-run cache is the boundary mode, because
`ActionPersistence` computes `cacheable = tier === "sealed" && boundaryMode ===
"hard"`. Measure and link declare `expected`, so neither is ever admitted.

Each Action is a declaration with schemas and no body. Its implementation
attaches separately with `toLayer`, exactly as
`docs/specs/Concepts/Unified Flow Authoring.md` requires. The Flow has a
required pure body and no executable code. It runs in two rounds:

```
round 1 (environment absent):
  Measure.call({})
    |> Node.andThen((measured) => Install.to({ environment: measured }))

round 2 (environment present):
  Fetch[environment.manager].call({ environment })
    |> Node.andThen((store) => Link.call({ store }))
```

The body passes planned values and never computes on them. It uses `call`, so
every step of a round splices into that round's plan and is individually
keyed. It uses `to` once, for the reason section 2.2 gives, and never `child`:
there is no execution boundary to buy here.

### 2.2 Why measure is a step, and why it is its own round

`docs/specs/Concepts/Build Phases.md` forbids the plan phase from reading the
world. A lockfile digest is a read of the world. Making measurement its own
Action moves that read into the run phase, where it is legal.

The separate round solves a static graph problem. The manager is selected by a
Layer and becomes known only when Measure runs. A pure round-one body cannot
inspect a `Planned<Environment>` as a JavaScript discriminant and choose one
manager-specific Action declaration. A generic fetch declaration would need
to declare every supported lockfile in its read set. That would put unrelated
lockfiles into the boundary and the key.

`to` ends round one and carries the measurement into round two as ordinary
payload. The round-two body can inspect `environment.manager` and name exactly
one fetch declaration. That declaration reads one lockfile and `.npmrc`.
Payload is hashed inline as an `InputRef.Literal`, so the fetch key folds the
manager name, exact manager version, platform, and both digests. Compiling
round two with the manager version and platform varied changes every node key.

The shipped scheduler already matches `docs/specs/Concepts/Step Keys.md` for
within-round data flow. `StepKey.dispatchIdentity` folds the digest of each
settled `Ref` result, projected along its path, plus the measured file
boundary. A generic single-round fetch would therefore have a correct content
key. It would still have the wrong static file boundary. The trampoline exists
to select that boundary, not to repair dispatch-key derivation.

Measure is not cache-admissible, and that is deliberate rather than
incidental. It reports the version of the package manager installed on this
host, which no declared read set covers, so a restored measurement would carry
the version of whichever machine recorded it first into every downstream key.
Re-measuring costs one `--version` spawn and two file digests.

### 2.3 Exact fetch key material

Fetch's key folds, as round-two payload:

1. **Lockfile digest.** SHA-256 of the manager's lockfile, paired with its path
   as a `FileInput`.
2. **Registry configuration digest.** SHA-256 of the project's `.npmrc` after
   checking that credential fields use environment-variable placeholders. The
   complete file is then digested. A literal token is refused because the hard
   boundary also hashes the file. The environment value is a capability and
   never enters a key or journal. The value is `null` when the project has no
   `.npmrc`.
3. **Package-manager identity and exact version.** The manager name and the
   output of `<manager> --version`, measured rather than declared.
4. **Platform**, as `{ os, arch, libc }`, included when the manager reports
   `platformSensitive`. All three shipped implementations report `true`,
   because optional dependencies resolve per platform and therefore the set of
   artifacts a fetch downloads varies per platform even where the store's
   addressing does not.

Plus what the engine folds into every key without being asked: the action's
declaration identity, its resolved layer set, the capability ceiling, and the
declared effects (`docs/specs/Concepts/Step Keys.md`). At dispatch the
scheduler folds the measured digests of the declared read set on top, so the
lockfile and `.npmrc` digests reach the key twice, once as payload and once as
boundary evidence.

The store directory and project root are not key material. The engine and
manager run from the same workspace root. Every implementation writes a fixed
workspace-relative store below `.flows/store/<manager>`. The Flow payload
contains only the measured environment. Two checkouts at different absolute
paths therefore compute the same fetch key when their declared content is the
same.

### 2.4 Fetch value and replay

Fetch returns a `StoreManifest`:
`{ manager, managerVersion, platform, digest }`. The `digest` is SHA-256 over a
canonical text built from the key material above. The value is a description.
It is never the store's bytes, never a tarball, and never a `node_modules`
archive.

Each fetch declares `.flows/store/<manager>` as a `TreeArtifact`. The
boundary records every file below that directory by content digest in the
existing artifact CAS. A cache hit removes that manager store, hydrates the
recorded tree, and then replays the fetch result. Link runs only after the
local store is present. npm and pnpm link in offline mode, so an incomplete
replay fails instead of reaching the registry.

The filesystem boundary can capture and replay the declared tree. It cannot
prove that the process wrote nowhere else, so it omits
`wholeTreeWritesVerified` and `hermeticReadsVerified`. The result remains
run-local. The sandbox boundary supplies those proofs and is required for
cross-machine publication. This is the limitation recorded in
`docs/specs/Concepts/Remote Cache.md`.

### 2.5 Link

Link always executes and is never restored from another machine. One mechanism
enforces that: its boundary mode is `expected`, and `ActionPersistence` admits
a result only when the tier is `sealed` **and** the boundary mode is `hard`.
The design wanted a second, redundant mechanism: a `compensable` tier, which
also expresses the correct retry and compensation policy. It cannot use it
because `Plan.compile` refuses to key non-sealed material. Section 7 records
the gap and section 6 records what closing it would buy.

Its step key still identifies the dispatch for replay and diagnostics. The
implementation keeps a local freshness marker at
`node_modules/.flows-link.json`. It holds the store manifest digest and the
linked-tree manifest digest. The latter folds the store digest, root
`package.json` digest, and the manager's evidence about the resulting tree.
When both still match, the Action executes but skips the manager command.
The marker is read on this host only, is never published, and is treated as
absent whenever it fails to parse: a damaged marker costs one link, not a
failure.

The link dispatch key folds the measured environment, the settled fetch
result, and the `package.json` boundary digest. Link rechecks the manager
version, platform, lockfile, and `.npmrc` before using either a fresh or cached
store. This makes its local freshness decision cover the selected lockfile and
root package manifest without admitting the result to the shared cache.

The Action declares no file output. The current boundary contract uses every
declared write as materializable artifact evidence. Declaring `node_modules`
as a `TreeArtifact` would therefore cache the tree even though the Action is
not cache-admissible. An isolated boundary may observe the undeclared write and
record an expected-set deviation, but `expected` mode does not fail the Action.
This is an API gap: the effects vocabulary has no non-materialized write.

Link's value is a `node_modules` manifest digest, never the tree:

| Manager | Evidence digested                          |
| ------- | ------------------------------------------ |
| npm     | `node_modules/.package-lock.json`          |
| pnpm    | `node_modules/.modules.yaml`               |
| Bun     | sorted top-level listing of `node_modules` |

Bun's evidence is coarse because Bun writes no manifest of the tree it linked.
Section 6 records that.

### 2.6 Package manager as a Layer

`PackageManager` is a `Context.Service` with one shape and several
implementations, selected by wiring:

| Manager | fetch                                                                                   | link                                                                                      | notes                                                              |
| ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| pnpm    | `pnpm fetch --store-dir .flows/store/pnpm`                                              | `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir .flows/store/pnpm` | `pnpm fetch` reads the lockfile and ignores the package manifest   |
| npm     | one `npm cache add <resolved-url> --cache .flows/store/npm` per registry tarball        | `npm ci --offline --no-audit --no-fund --ignore-scripts --cache .flows/store/npm`         | npm has no fetch-only verb; eight cache additions run concurrently |
| Bun     | `bun install --frozen-lockfile --ignore-scripts --dry-run --cache-dir .flows/store/bun` | `bun install --frozen-lockfile --ignore-scripts --cache-dir .flows/store/bun`             | see below                                                          |
| Yarn    | not implemented                                                                         | not implemented                                                                           | `layerNoop("yarn", ...)` refuses with a typed `unsupported` error  |

All implemented layers override the manager's default global cache directory.
They place store data under `.flows/store/<manager>`. This deviates from the
prompt's `~/.npm` and Bun global-cache examples. The existing flows boundary
can only declare and replay workspace-relative outputs. A workspace-local store
lets the existing artifact CAS move fetched package data between machines
without moving `node_modules`.

**npm.** Reading resolved tarball URLs out of `package-lock.json` is the one
piece of lockfile parsing in the design. It is coarse by choice: the fetch step
is keyed on the whole lockfile, so the parse only decides what to download,
never what to key. Workspace links and non-HTTP sources are skipped. They may
make the later offline install fail. Supporting them requires a separate
source fetcher.

**Bun.** Bun documents no fetch-only verb. This design does not claim how much
of the configured `.flows/store/bun` cache `--dry-run` warms. If it warms
nothing, the following link downloads what is missing. The result remains
correct but takes longer. Bun also documents no offline install flag, so Bun's
link can reach the network when the cache is incomplete. Bun therefore has the
weakest guarantee in section 2.4.

**Yarn.** The abstraction is capable of Yarn without change: classic Yarn
fetches into a mirror directory and links a tree, so it fits the two verbs
directly. Yarn PnP is the degenerate case: fetch populates the zip cache, and
link produces a manifest digest of `.pnp.cjs` and `.yarn/cache` without
building a tree. Neither is implemented here, because writing an
implementation this design cannot exercise would be a claim rather than code.
`layerNoop` represents the unsupported implementation explicitly.

### 2.7 Lifecycle scripts

Every command runs with `--ignore-scripts`. Running arbitrary package code is a
different action with a different tier. It is at least `compensable` and often
`irreversible`, and it is not sealed by any lockfile digest. Modelling it is
deferred work, listed in section 6. The README and design state this omission
explicitly.

### 2.8 The workspace cache directory

The root `BUILD.ts` file may export one `Workspace` declaration from
`tsflows-rules`:

```ts
export const config = Workspace({ cacheDirectory: ".flows", gitignored: true })
```

`Workspace` validates and performs no I/O, so BUILD.ts evaluation stays pure.
`cacheDirectory` names a single workspace-relative directory: an empty value,
an absolute path, and any `..` segment are refused, so the directory can never
escape the workspace. It defaults to `.flows` and `gitignored` defaults to
false.

Every CLI command resolves the directory before it reads or writes anything.
Precedence is the `--cache-dir` flag, then the declaration, then `.flows`.
`gitignored` comes only from the declaration, because it is a workspace policy
rather than a per-run choice; when it is true the command first ensures the
root `.gitignore` carries an entry for the directory, creating the file when it
is absent and leaving it untouched when any equivalent entry already exists.

What moves with the directory is host state: the CLI result cache under
`<cacheDirectory>/cache` and the generated knip configuration `DepsLint`
writes. What does not move is the resolved directory's own name. It never
enters rule attrs, key material, or a content digest, because it names where a
host keeps replayable files and two checkouts that configured it differently
must still agree on every key.

Discovery drops the directory unconditionally. Git-listed workspace files, the
recursive fallback listing, and declared-glob expansion all skip it even when
the workspace does not ignore it, so cache content can never feed input
discovery or a digest. The same paths always skip the fixed `.flows/store`
subtree when another cache directory is configured.

Store placement stays fixed at `.flows/store/<manager>` and is not controlled
by `cacheDirectory`. Section 2.4 declares those paths as `TreeArtifact`
boundaries, and a declared boundary is key material that must mean the same
thing on every machine. Making store placement configurable is future work; it
requires the boundary to carry the store location as resolved host state rather
than as a declared path.

## 3. Cache lookup, validation, publication, and restore

Nothing here is new protocol. The flow uses the `Cache` service that
`docs/specs/Specs/Object Model.md` already declares and the two-store split
`docs/specs/Concepts/Remote Cache.md` already built.

**Lookup.** The plan phase computes every step key in a round, so round two's
plan reports whether fetch is a hit before anything runs. Round one is one
uncached step, so there is nothing to report about it. At dispatch,
`PlanScheduler` measures the node's declared boundary, derives the dispatch
key, and asks `ActionPersistence`. `CombinedCacheStore` tries the local
`flows_step_cache` row first and the shared tier second.

**Validation.** A hit is only used when the boundary evidence still describes
reality. For fetch, that is the measured read set: lockfile and `.npmrc`
digests. The replay then materializes the declared package-store outputs.
Before a fresh fetch, its implementation rechecks the manager identity,
version, platform, lockfile, and `.npmrc` against the round-one payload. This
guard catches a durable handoff resumed under different layer wiring.
Link also checks the current manager, version, and platform against the store
manifest. That guard runs after a fetch cache hit as well as after fresh work.
Artifacts are digest-verified on every read, and the three outcomes
stay distinct: a miss is ordinary, a corruption routes to the inconsistency
receiver, and a transport refusal is retryable and says nothing about
existence. npm and pnpm validate the hydrated store again by linking offline.

**Publication.** Blobs before metadata, always: probe the shared artifact tier
with `POST /cas/findMissing`, upload what is missing with `PUT /cas/{digest}`,
confirm, write the local cache row, then publish the entry with
`PUT /ac/{keyDigest}`. A shared entry must never be observable while an
artifact it references is missing. Publication never fails a run; a refusal
withholds the shared copy and is journalled as `cache-provenance` with
`action: "unpublished"`.

**Restore.** Downloads are lazy. A locally missing artifact is a distinct typed
refusal, and the dispatch fetches, verifies, writes back, and retries the
replay exactly once before doing the work for real.

**Scope today.** `docs/specs/Concepts/Remote Cache.md` states that the shared
tier admits nothing under the production boundary yet, because the shipped
filesystem boundary observes only the declared read set and cannot attest
whole-tree writes. That caveat applies here unchanged. The fetch step is
designed to be admissible, and it becomes admissible when the sandbox execution
lane attests the complete execution tree. The filesystem boundary can execute
fetch and materialize its declared `TreeArtifact`, but its evidence remains
run-local. The sandbox lane is required for remote publication.

**Credentials.** The cache endpoint and its bearer token arrive as layer
construction options. They are capabilities, never inputs, so they are not
hashed into a key and never enter the journal.

## 4. The Postgres cache model

`terraform/modules/cache/migrations/0001_initial.sql` is the schema. It serves
the same two stores over the same protocol, in Postgres instead of SQLite plus
a filesystem CAS.

**`tsflows_cache_entry`** is the step cache, keyed by step-key digest. Its
columns mirror `CacheStore.CacheEntry` field for field: `key_digest` primary
key, `result` and `meta` as `jsonb`, `created_at_ms`, and the journal
provenance pair `recorded_run_id` and `recorded_event_seq` that a fenced
eviction compares against. First-writer-wins is `ON CONFLICT DO NOTHING`, and
the three outcomes the client expects fall out of it: `201` inserted, `200`
when the stored `result` is identical, `409` when the result differs. Metadata
does not participate in conflict classification, matching `CacheStore`. One
content address producing two different results is a hermeticity violation.
The client's inconsistency receiver decides what to do about it.

**`tsflows_artifact`** is the content-addressed store: `digest char(64)`
constrained to lowercase hex, `content bytea`, and `size_bytes`. The server
measures every upload and refuses bytes that do not match their address, so a
mis-addressed write cannot poison readers.

**`tsflows_cache_entry_artifact`** records which artifacts an entry references,
with a cascade from the entry and a restriction on the artifact. The server
populates it by scanning the entry's JSON for digests that already name a blob.
That is a heuristic and it is deliberately not an integrity gate: a recorded
result may legitimately contain a digest that names no blob, as this design's
own store manifest digest does, and refusing such entries would break them. The
publication ordering guarantee stays where `Remote Cache.md` puts it, in the
client. What the table buys is safe eviction.

**Access tracking** is a column pair on both tables, `last_accessed_at` and
`access_count`, updated by the same statement that serves the read, so the
tracking cannot drift from the reads it describes. Both tables carry an LRU
index.

**Eviction** is two functions, `tsflows_release_entries(cutoff, budget)` and
`tsflows_release_artifacts(cutoff, budget)`, plus the
`tsflows_unreferenced_artifact` view they draw from. Nothing deletes on its
own. Release is an explicit verb because deletion is the irreversible
direction, and a human approving a plan should be approving the deletions
(`docs/specs/Concepts/Reconciliation.md`). Artifact release only ever considers
unreferenced artifacts, so an entry can never survive its blobs. CAS probes and
duplicate uploads refresh `last_accessed_at`. An artifact release must use a
cutoff older than the maximum publication window. That grace period prevents a
probe-to-entry publication from racing age-based release.

**Why a service and not Postgres alone.** The client speaks HTTP:
`GET`/`PUT`/`DELETE /ac/{keyDigest}`, `GET`/`PUT`/`HEAD /cas/{digest}`, and
`POST /cas/findMissing`. Postgres does not serve HTTP, so
`terraform/modules/cache/service/` is a small Bun program that translates that
protocol onto these tables and adds nothing to it. Claiming Postgres alone
implements the protocol would be false.

## 5. Terraform

`terraform/modules/cache` runs two containers on a private Docker network:
Postgres with the migration mounted into `/docker-entrypoint-initdb.d`, and the
cache service built from the module's own `service/` directory. Only the
service port is published, and it binds to `127.0.0.1`. The provider is pinned
to `kreuzwerker/docker 3.9.0` and the images to specific release tags.
`terraform/examples/docker` wires the module with a listening port and two
sensitive credential inputs. The SQL schema and HTTP service are
provider-neutral. The Terraform resources use Docker because a
provider-neutral resource cannot provision a database or service. This is the
documented deviation from the preferred provider-agnostic core module.

Replacing Docker Postgres with RDS or Cloud SQL means deleting
`docker_container.postgres`, `docker_volume.postgres_data`, and the initdb
mount, applying the migration through whatever path the managed database
already has, and pointing `local.database_url` at the managed endpoint. The
service container does not change, because its only coupling to Postgres is
`DATABASE_URL`. The comment at the top of `main.tf` says the same thing next to
the code.

## 6. Open questions and deferred work

**Deferred deliberately, per the task's scope:**

1. **Per-package integrity granularity.** Fetch is keyed on the whole lockfile,
   so adding one dependency re-fetches conceptually even though the manager
   only downloads the delta. rules_js keys per package, per integrity hash. The
   step-cache shape supports it: fetch becomes a fan-out over entries, each
   keyed by `name@version` plus integrity. It needs a faithful parser per
   lockfile format, and static fan-out means the entry list must arrive as
   payload from an earlier round (`docs/specs/Concepts/Trampoline Loops.md`).
2. **Lifecycle scripts as separate actions.** A `postinstall` is arbitrary code
   with host effects. It belongs in its own action, at `compensable` or
   `irreversible`, with its own capability set, and it must not be sealed by a
   lockfile digest.
3. **Yarn implementations.** Classic Yarn and Yarn PnP fit the same service
   contract. This scaffold exposes an explicit unsupported layer until their
   store formats and resolution artifacts have tests.

**Open questions:**

4. **Production boundary selection.** Each fetch action declares its manager
   store as a `TreeArtifact`. The filesystem boundary can capture that tree but
   cannot attest writes outside it. Remote publication therefore requires the
   sandbox lane.
5. **User-level and host-level `.npmrc`.** Only the project's `.npmrc` is
   digested. A `~/.npmrc` that redirects a scope to another registry changes
   what a fetch downloads and is invisible to the key. Reading `$HOME` from a
   sealed step is the unsealed reach `Step Keys.md` forbids, so the
   answer is probably to make the effective configuration a declared,
   discovery-phase input rather than a run-time read.
6. **Bun's cache semantics.** Whether `bun install --dry-run` populates the
   tarball cache or only the manifest cache decides whether Bun's fetch step is
   worth anything. Measuring it, rather than asserting it, is the next step.
7. **Store metadata review.** Remote publication includes manager index files,
   not only package bytes, because offline linking needs both. Before enabling
   a manager in a shared deployment, tests must prove its store does not retain
   registry authorization headers or machine-specific paths.
8. **Reference extraction.** Scanning entry JSON for 64-hex strings can pin an
   artifact that the entry does not really reference. It errs toward retention,
   which is the safe direction, but a typed reference list in `meta` would be
   better.
9. **Package-store release.** The step cache can evict remote entries and CAS
   blobs. The workspace-local `.flows/store` also needs an explicit release
   workflow. This scaffold leaves manager stores intact.
10. **Non-sealed Action declarations do not plan.** `Plan.compile` calls
    `StepKey.fromKeyMaterial` for every node, and that function refuses
    `compensable` and `irreversible` material. `StepKey.ordinal` exists and
    accepts exactly those tiers, so the compiler appears to be missing the
    branch that reaches it. Until it lands, an authored flow cannot express a
    tier other than `sealed`, and this design compensates with boundary mode.
    Whether that is an engine bug or a deliberate restriction is unresolved;
    nothing in the repository declares an Action at either tier, so there is no
    precedent to read.
11. **Non-materialized writes.** The effect declaration uses one write set for
    scheduling, sandbox enforcement, and artifact materialization. Link needs
    the first two properties for `node_modules` and must refuse the third.
    Until the API separates them, Link leaves its output set empty and relies
    on its data dependency for ordering. A sandbox records the write as an
    expected-set deviation.

## 7. References and deviations

Every source, and every place this design departs from it.

**`docs/specs/Concepts/Unified Flow Authoring.md`.** Followed: two nouns, an
atom whose implementation attaches with `toLayer`, a Flow with a required pure
body, and `call` for inline splicing. The current note and shipped package both
call the atom `Action` and construct it with `Action.make`. **Prompt
discrepancy:** the task calls the atom `Activity` and names a file that does
not exist. The code uses `Action`, which is the current API noun. The tier
literals are `sealed`, `compensable`, and `irreversible`.

**`docs/specs/Concepts/Step Keys.md`.** Followed: content-digest identity, the
sealed precondition, and the plan-key versus dispatch-key split.
`StepKey.fromKeyMaterial` folds dependency plan keys into the static plan key.
`StepKey.dispatchIdentity` separately folds settled result digests and the
measured boundary into the cache address. This matches the note. Two
deviations remain, both forced by code and verified against the compiler:

- The note lists `capabilities` as per-step key material. `Graph.build` reads
  the capability ceiling from the Flow's `Flow.Capabilities` annotation and
  copies it onto every node; an `Action` declaration's own `Flow.Capabilities`
  annotation is never read. Verified by building the plan both ways. The design
  therefore declares the ceiling on the Flow, and the steps share one
  capability set that is wider than any of them needs.
- The note treats the three tiers as authorable. `Plan.compile` refuses to key
  anything but `sealed`, so `compensable` and `irreversible` are unreachable
  from an `Action` declaration today. Measured directly: declaring `Link` as
  `compensable` makes `Plan.compile` fail with `non_content_material`. The
  design declares every tier `sealed` and separates the cache-admissible step
  from the others with boundary mode, which is what `ActionPersistence`
  actually reads. Open question 10.

**`docs/specs/Concepts/Remote Cache.md`.** Followed exactly: two stores, hex
SHA-256 addressing, digest-verified reads, the miss/corruption/refusal
distinction, local-first with write-back, blobs before metadata, publication
never failing a run, endpoint and credentials as capabilities, lazy downloads
with one repair retry, and release as an explicit verb. **No deviation.** The
Postgres model is that protocol served from different storage, not a second
protocol. The note's own caveat that the shared tier admits nothing under the
production boundary today is restated in section 3.

**`docs/specs/Specs/Object Model.md`.** Followed: `Cache` owns results by step
key plus a content-addressed artifact store; a remote thing is a layer, not a
concept, which is why the package manager is a layer and not a hierarchy of
classes.

**`docs/specs/Concepts/Vendored Workflow Engine.md`.** Read for the engine
seam. Nothing here forks or touches it. Key computation lives above the
`Encoded` seam, which is what lets this design assume the same keys under the
memory runtime and the durable one.

**`docs/specs/Concepts/Build Phases.md`.** Followed: the body is pure, reads
nothing, and spawns nothing. Measurement is a run-phase Action precisely so
that planning stays a pure function of declarations, payload, and recorded
state.

**`docs/specs/Concepts/Trampoline Loops.md`.** Followed: `to` ends a round and
names the next, `maxRounds` bounds the lineage as a budget rather than as loop
detection, and the self-handoff drops requirements so the recursive type stays
finite. The self-referential declaration copies the `CounterFlow` pattern in
`flows/packages/flow/test/Trampoline.test.ts`, including the explicit
`Flow.Flow<...>` annotation that breaks the initializer cycle.

**Real APIs read.** `Flow.make` with a required `body`, `maxRounds`, and `to`;
`Action.make`'s two overloads, where the first argument being a string selects
the declared form; `Declared.toLayer` and the `Requirement<Tag>` it provides;
`Node.andThen` with a `Planned` continuation; `Graph.build`, `Graph.drafts`,
and `Graph.diagnostics`; `Plan.compile`, `KeyMaterial`, and `StepKey`;
`StepKey.dispatchIdentity` and `PlanScheduler`'s result-digest dispatch-key
derivation; `FileSet.TreeArtifact`; `ActionPersistence`'s admission rule;
`Flow.EffectsDeclaration` and `Flow.Capabilities` as annotations;
`BoundaryMode` as `hard` or `expected`; `FileInput` as `{ path, digest }`; the
`CacheEnvironment` shape; `CacheStore.CacheEntry`; and the wire behaviour of
`RemoteCacheStore` and `RemoteArtifacts`, including the exact status vocabulary
the service implements. Three tests were read for authoring style,
`ActionDeclared.test.ts`, `FlowAuthoring.test.ts`, and `Trampoline.test.ts`.

Both rounds of this flow were built with `Graph.build` and compiled with
`Plan.compile` against the real packages. Round one plans measure and the
handoff; round two plans fetch and link. Compiling round two with the manager
version and with the platform varied changes every node key, which is the
check that section 2.3's key material is real and not asserted.

**Bazel Skyframe.** Inspected as described in section 1.2. Deviation: Skyframe
versions nodes with a monotone `IntVersion`; flows content-addresses instead,
and this design follows flows.

**Effect package conventions.** The source layout, namespace exports, public
JSDoc, field order, export map, pinned dependencies, and script names follow
`reference/effect/packages/effect` and the current `flows/packages/flow`
adaptation. Deviation from upstream Effect: this package uses the flows build
script for dual ESM/CJS output. Upstream Effect's package currently publishes
one compiled module layout. The flows package is the direct template required
by this workspace.

**The dogfood target.** The task states that `/Users/williamcory/flows/flows`
is an npm workspaces monorepo with `package-lock.json`, and forbids running
pnpm against it. On disk it is a pnpm workspace: `pnpm-workspace.yaml`,
`pnpm-lock.yaml`, `"packageManager": "pnpm@11.21.0"`, and no
`package-lock.json`. Both facts were checked. The consequences are:

- The npm layer cannot install it, because `npm ci` requires a
  `package-lock.json` that does not exist.
- The pnpm layer matches the repository but the task forbids running it there.

So the dogfood available today is the plan, not the run. From that workspace,
`Graph.build(Install, {})` is pure and touches nothing. It was executed as part
of verification. Running `install` end to end needs either a genuine npm
workspace or permission to run pnpm against the flows repository. README.md
states the same limitation.
