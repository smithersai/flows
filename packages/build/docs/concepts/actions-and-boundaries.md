# Actions and boundaries

A target body records plan nodes. The nodes that touch the world are **action
calls**. An action is a declaration: a payload schema, a success schema, an error
schema, a tier, and an effects annotation. Its implementation attaches separately
as a layer.

## Tiers

| Tier           | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `sealed`       | Content-keyable. The plan compiler accepts it.                       |
| `compensable`  | Requires compensation on retry.                                      |
| `irreversible` | Must never be retried blindly, replayed, or run to populate a cache. |

`StepKey.fromKeyMaterial` fails with `non_content_material` for `compensable` and
`irreversible` material, and `Plan.compile` keys every node, so a single
non-sealed action makes a flow unplannable. Every action in the `Install` flow is
therefore `sealed`, including link, which the design would otherwise declare
`compensable`.

`ExecIrreversible` is the exception, and it is not part of a plannable install
flow. The release targets use it for runs that mutate manifests or external
registries.

## Boundary modes

An action's effects annotation declares what it reads, what it writes, and its
boundary mode.

| Mode       | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `hard`     | The declared read and write set is the complete set.                                        |
| `expected` | The declared set is what the action expects; an observed deviation is recorded, not failed. |

`ActionPersistence` admits a result to the cross-run cache only when the tier is
`sealed` **and** the boundary mode is `hard`. Boundary mode, not tier, is what
keeps a result out of the shared cache.

## The install boundaries

| Action                                   | Tier     | Boundary   | Reads                              | Writes                                     | Cache-admissible |
| ---------------------------------------- | -------- | ---------- | ---------------------------------- | ------------------------------------------ | ---------------- |
| `smithers-build/install/measure`         | `sealed` | `expected` | `.npmrc`, every supported lockfile | none                                       | No               |
| `smithers-build/install/fetch/{manager}` | `sealed` | `expected` | the manager's lockfile, `.npmrc`   | `TreeArtifact` at `.flows/store/<manager>` | No               |
| `smithers-build/install/link`            | `sealed` | `expected` | `package.json`                     | none                                       | No               |

Fetch is shaped as the potentially shareable half, but it is not shared today.
The absolute-root package-manager process can open the lockfile and `.npmrc`
after the parent verifies them, and the current observer cannot freeze those
paths or prove there were no undeclared effects. Calling that boundary `hard`
would be a false hermeticity claim.

Measure is not admissible because it reports the host's package-manager version,
which no declared read set covers. A restored measurement would carry the version
of whichever machine recorded it first into every downstream key.

Link is not admissible because a `node_modules` tree is a graph of links into a
local store. Restoring one from another machine would produce a tree pointing at
nothing. Link declares no write on purpose: the current boundary contract turns
every declared write into materialized artifact evidence, so naming
`node_modules` would cache the tree it is forbidden to cache.

## The shared exec action

Catalog targets do not declare their own actions. They call one shared action,
`smithers-build/exec`, declared `sealed`.

```ts
Payload = {
  cwd: string                        // resolved against the workspace root
  argv: NonEmptyArray<string>        // argv[0] is the executable
  env: Record<string, string>        // merged over process.env, default {}
  expectedExitCodes: Array<number>   // default [0]
  after?: unknown                    // an upstream planned result, for ordering
}

Result = { exitCode: number, stdout: string, stderr: string, durationMs: number }
```

`ExecLive` implements it with `node:child_process.spawn`. Never through a shell.
Killing the fiber kills the child. `stdout` and `stderr` are truncated to 200 KiB;
an `ExecError`'s `stderr` carries the last 8 KiB, or the spawn error message when
nothing ran and `exitCode` is `-1`.

Each stream is decoded by its own streaming UTF-8 decoder, so a code point whose
bytes land in two pipe chunks decodes once and correctly. Decoding each chunk on
its own made captured output depend on where the kernel happened to break the
pipe, which made one command's result differ between runs and from its own cache
entry. Both bounds are counted in UTF-16 code units, and neither the head nor the
tail is ever cut between the halves of an astral code point.

The run settles exactly once. A failed spawn emits `error` and then `close`, a
pipe can fail alongside either, and only the first of them answers; the rest are
dropped with the listeners. A tool the kernel killed is always a failure, and the
signal is named in the diagnostic rather than flattened into `exitCode` `-1`. A
pipe that fails mid-run fails the target instead of reporting the truncated text
it managed to capture.

The child is spawned detached, so interrupting the fiber signals its whole
process group and takes its children with it. Windows has no process groups: the
fallback there terminates the child alone, and a grandchild it started outlives
the kill. No Node API changes that.

`after` carries no data to the spawn. It exists so an upstream step is a material
dependency the engine settles first. Without it, two keyless exec steps dispatch
at once and the engine refuses with `ConcurrentKeylessDispatch`.

## The other actions

| Action group                                    | Tier           | Provided by the CLI executor    |
| ----------------------------------------------- | -------------- | ------------------------------- |
| `exec`, `capture-outputs`, `filegroup`          | `sealed`       | Yes                             |
| `write-file`, `check-file`, `sync-package-json` | `sealed`       | Yes                             |
| `check-workflow`, `check-docs`, `llm-review`    | `sealed`       | Yes                             |
| `scaffold-package`, `not-implemented`           | `sealed`       | Yes                             |
| `smithers-build/install/*`                      | `sealed`       | Yes, under pnpm                 |
| `smithers-build/exec-irreversible`              | `irreversible` | Yes, under the `run` verb only  |

The ordinary implementations are re-exported from the `@smthrs/targets` package
root. `ExecIrreversibleLive` comes from the Changesets module and the executor
provides it only when the verb is `run`; under `build`, `test`, `lint`, and
`docs` the action is implemented by a refusal that fails the target without
executing anything. `ExecIrreversibleLive` takes only the workspace root — no
cache directory, sensitive-env list, or sandbox policy — so an irreversible
step currently runs under different confinement than every sealed action.
Aligning the two is a tracked follow-up.

An action call with no implementation in scope is a wiring error, not a runtime
contingency. The interpreter refuses with `unresolved_action` before it runs
anything. See [Running targets](../workspace/running-targets.md#what-executes).

## Host state never reaches a payload

The resolved cache directory is host state: it names where one machine keeps
replayable files, so two checkouts that configured it differently must still
agree on every key.

`DepsLint` needs to write a generated knip config into that directory. It emits
the constant token `{smthrs:cache-directory}` in its argv at plan time.
`ExecLive` validates the host directory and substitutes it into every argument
immediately before spawn. The real path therefore never enters an action payload
or a step key.

## Hermeticity today

Projection is opt-in. A target declares `sandbox: true` and, under the default
`declared` workspace policy, its tool runs in a scratch root seeded with
exactly the declared inputs; a `forced` policy projects every target. An
undeclared read fails there instead of succeeding invisibly. Projection is a
determinism boundary, not a security boundary: a child that opens an absolute
path still reaches the workspace.

Two escape hatches exist and neither disables caching. A target leaves
`sandbox` at its default of `false` to stay on the workspace under the
`declared` policy, and a run passes `--dangerously-no-sandbox`, which overrides
the declared policy for the whole invocation. The `forced` policy wins in both
directions and projects every target regardless of the field. An un-sandboxed
target still stores and consumes cache entries; the projection mode is key
material, so a sandboxed and an un-sandboxed run of one target never share an
entry. There is no quiet `--no-sandbox`: the option parser reads any leading
`--no-` as boolean negation, so the key is deliberately named
`dangerouslyNoSandbox` and a bare `--no-sandbox` is rejected.

`ExecLive` spawns the tool with `process.env` narrowed to an allowlist, merged
under the payload `env`, minus `SMITHERS_CACHE_URL` and the declared
remote-cache token variable. Outside projection, nothing prevents a tool from
reading or writing outside its declared set.

A `BUILD.ts` file is not sandboxed either, and it is not meant to be. It is
executable TypeScript evaluated in the CLI process: it can import any host
module, read any file you can read, and spawn any process. Evaluating a
workspace is exactly as trusted as running that repository's own code. The CLI
does not empty `process.env` around the evaluation, because a module that wants
the environment can read it another way and emptying a process-global would
corrupt any concurrent caller. What the CLI does guarantee is narrower and
real: token values never enter a declaration, a target key, or a stored cache
entry, and the child-process environment is where the credential is withheld.

The shipped filesystem boundary can measure a declared read set and capture and
replay a declared `TreeArtifact`. It cannot prove that a process wrote nowhere
else, so it omits the whole-tree and hermetic-read proofs and its evidence stays
run-local. The concrete consequence is that no fetch result is admitted to the
shared tier today, even though the action is designed to be admissible.

The sandbox execution lane supplies those proofs. It is not wired. See
[Remote caching](../workspace/remote-caching.md#the-current-engine-boundary).

## Next

- [Install](install.md)
- [Writing targets](../extending/writing-targets.md)
- [Remote caching](../workspace/remote-caching.md)
