# Running targets

A verb selects a target set, plans its transitive dependency closure, and
executes it. Targets carry no per-command scripts.

```sh
tsflows install --workspace .
tsflows build //packages/...
tsflows test //packages/flow:test
tsflows lint //packages/flow:lint
tsflows ci //...
```

For every flag, output field, and exit code, see
[the CLI reference](../reference/cli.md).

## Verb selection

Each rule declares the verbs it participates in as its `kinds`. `build`, `test`,
and `lint` select the targets a pattern matches whose kinds include that verb.
`ci` plans all three over one pattern and merges them.

| Verb      | Selects targets whose kinds include       | Executes             |
| --------- | ----------------------------------------- | -------------------- |
| `build`   | `build`                                   | Yes, unless `--plan` |
| `test`    | `test`                                    | Yes, unless `--plan` |
| `lint`    | `lint`                                    | Yes, unless `--plan` |
| `ci`      | `build`, `test`, `lint`, merged           | Yes, unless `--plan` |
| `install` | Not label-driven; runs the `Install` flow | Yes                  |
| `query`   | Every target the pattern matches          | No                   |
| `graph`   | Every target the pattern matches          | No                   |

An exact label that does not participate in the verb fails with
`target selected by <pattern> does not support the <verb> verb`. A recursive
pattern that matches nothing for a verb selects nothing and plans an empty graph.
`ci` tolerates a per-kind refusal as long as at least one kind accepts the
pattern.

**There is no `run` verb.** `Rule.Kind` includes `run` and several rules declare
it, but `cli/src/Cli.ts` defines no `run` command. A `run`-kind target is never
selected as a root. It still appears in `query` and `graph`, and it still
executes when a selected target depends on it.

## What executes

The executor composes one runtime per target. It supplies the install action
implementations, the shared exec implementation `ExecLive`, the generated-file
implementations `WriteFileLive` and `CheckFileLive`, and the not-implemented stub
layer.

It does not supply the irreversible-exec or llm-review implementations. A target
whose plan calls one of those actions fails at interpretation with an
`unresolved_action` refusal.

| Rule                                                           | Root verb       | Executes today                                                                                          |
| -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `TsBuild`, `DtsBuild`, `Typecheck`, `ToolBuild`, `TypedocDocs` | `build`         | Yes                                                                                                     |
| `Vitest`, `VitestCoverage`                                     | `test`          | Yes                                                                                                     |
| `EsLint`, `BiomeCheck`, `DepsLint`, `PackageLint`              | `lint`          | Yes                                                                                                     |
| `SortPackageJson`                                              | `build`, `lint` | Yes                                                                                                     |
| `PackageJsonCheck`                                             | `lint`          | Yes, through `SyncPackageJsonLive`                                                                      |
| `PackageJsonWrite`, `PackageJsonRefresh`                       | `run`           | Yes, through `SyncPackageJsonLive`; explicitly mutates the source tree                                  |
| `GithubCiGen`                                                  | `build`, `lint` | Yes, through `WriteFileLive` and `CheckFileLive`                                                        |
| `PnpmWorkspace`                                                | none (`run`)    | Yes, as a dependency                                                                                    |
| `Clean`, `Dev`, `VitestWatch`                                  | none (`run`)    | Yes, as a dependency; `Dev` and `VitestWatch` are long-lived and block their slot                       |
| `LlmLint`                                                      | `lint`          | No: the llm-review action has no implementation in scope                                                |
| `Changesets`                                                   | none (`run`)    | `status` yes as a dependency; `version` no, the irreversible-exec action has no implementation in scope |
| `NpmPublish`, `JsrPublish`                                     | none (`run`)    | No: the irreversible-exec action has no implementation in scope                                         |

A `BUILD.ts` that exports an `LlmLint` target therefore fails
`tsflows lint //...` on that one target while every other target still runs.
Keep-going semantics contain the failure to its dependent cone, and the run's
exit code is 1.

## Verb-effective attrs

A rule that declares several kinds can execute a different form under each one.
`GithubCiGen` maps the `lint` verb to its drift-check form. `PackageJson` uses
separate check, write, and refresh targets instead.

Because the planner resolves attrs, declared inputs, and cacheability per verb,
one target can have two different content keys. `tsflows ci` merges the three
plans on label and keeps the first occurrence, and `build` is planned first, so a
generator target runs its write form under `ci`.

See [Verb-effective attrs](../concepts/targets-and-rules.md#verb-effective-attrs).

## Execution semantics

- **Order.** The plan lists dependencies before dependents. The executor drains
  that list with at most `--jobs` targets in flight, defaulting to the host's
  available parallelism. `jobs` must be a positive integer; the programmatic API
  refuses anything else rather than silently running nothing.
- **Keep going.** A failed target fails the run, but only its transitive
  dependents are skipped. Every unrelated target still executes, and every result
  is collected. An internal fault, as opposed to a target failure, stops further
  dispatch and still waits for the targets already in flight before it is
  reported, so nothing keeps writing to the workspace or the cache after the run
  has returned.
- **Cache.** Before a cacheable target runs, its content key is looked up in the
  workspace cache. A stored green result reports `hit` and skips the run. A green
  run stores its result. `--no-cache` bypasses reads and still writes. See
  [Caching](caching.md).
- **Working directory.** The whole run happens with the process working directory
  moved to the workspace root, restored afterwards.
- **Runtime isolation.** Each target gets a fresh in-memory flows runtime, because
  two targets of one rule share a flow tag.

## Output

One status line per settled target goes to standard error, followed by a summary:

```
//packages/flow:lib  hit  2ms
//packages/engine:lib  ran  3.1s
//packages/engine:test  failed  0.4s  {"_tag":"tsflows-rules/ExecError", ...}
//packages/app:lib  skipped  0ms  dependency //packages/engine:test did not succeed
4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (3.6s)
```

Each field is separated by two spaces; the columns are not padded.

The command's structured result goes to standard output. It reports the verb, the
pattern, the job count, the total duration, per-status counts, the `ok` verdict,
and every target's report.

## Planning only

`--plan` prints the inert plan instead of executing it. The plan is the same
structure the executor consumes: dependency-first targets, expanded declared
inputs, the four key-material fields, and the sha256 content key.

```sh
tsflows build //... --plan
tsflows ci //... --plan
```

`query` and `graph` never execute. See [Querying](querying.md).

## Installing dependencies

`tsflows install` does not take a label. It resolves the workspace and cache
directory, then plans and executes the `Install` flow under the pnpm
package-manager layer.

```sh
tsflows install --workspace /path/to/workspace
```

The result reports the workspace path, the manager, the round-one plan nodes, and
the link manifest. See [Install](../concepts/install.md).

## Next

- [Querying](querying.md)
- [Caching](caching.md)
- [CLI reference](../reference/cli.md)
