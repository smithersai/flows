# CLI reference

```
tsflows <command> [args] [options]
```

`tsflows` is built with [incur](https://github.com/wevm/incur). Every command
returns a structured result on standard output. Option names are the kebab-case
form of their schema key, so `cacheDir` is `--cache-dir`. A boolean option that
defaults to true is turned off with its `--no-` form.

Commands: [`install`](#install), [`build`](#build), [`test`](#test),
[`lint`](#lint), [`ci`](#ci), [`query`](#query), [`graph`](#graph).

## Common options

Every command accepts these.

| Option        | Alias | Type   | Default                       | Description                                                                                          |
| ------------- | ----- | ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--workspace` | `-w`  | string | the process working directory | Workspace root containing `BUILD.ts` files                                                           |
| `--cache-dir` |       | string | unset                         | Workspace-relative cache directory. Overrides the root `BUILD.ts` `Workspace` declaration and `.flows`. |

`build`, `test`, `lint`, and `ci` also accept:

| Option                   | Alias | Type        | Default                    | Description                                                                            |
| ------------------------ | ----- | ----------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `--plan`                 |       | boolean     | `false`                    | Print the inert plan instead of executing                                              |
| `--jobs`                 | `-j`  | integer ≥ 1 | host available parallelism | Maximum concurrent targets                                                             |
| `--cache` / `--no-cache` |       | boolean     | `true`                     | Consult the result cache before running. `--no-cache` bypasses reads and still writes. |

incur supplies its own globals on every command, including `--help`,
`--version`, `--json`, `--format <toon\|json\|yaml\|md\|jsonl>`,
`--filter-output <keys>`, `--full-output`, `--schema`, `--llms`, and the
`--token-count`, `--token-limit`, and `--token-offset` trio. Run
`tsflows <command> --help` for the full list. Output is TOON by default.

## Startup sequence

Every command does the same three things before its own work.

1. Resolve the workspace root from `--workspace`.
2. Resolve the cache directory: `--cache-dir`, then the root `BUILD.ts` `Workspace`
   declaration, then `.flows`. Resolving the declaration evaluates the root
   `BUILD.ts` if one exists.
3. If the declaration sets `gitignored: true`, ensure the root `.gitignore`
   carries an entry for the resolved directory.

`install` stops there. The others then open the workspace index, which lists
discoverable files.

---

## install

Plans and executes the `Install` flow under the pnpm package-manager layer. It
takes no label.

```sh
tsflows install
tsflows install --workspace /path/to/workspace
```

Options: the [common options](#common-options) only.

The flow runs with the process working directory moved to the workspace root,
restored afterwards. The execution id is derived from the workspace path.

Result:

| Field       | Description                                            |
| ----------- | ------------------------------------------------------ |
| `workspace` | The resolved absolute workspace path                   |
| `manager`   | Always `"pnpm"`                                        |
| `plan`      | The round-one plan nodes as `{id, kind, dependencies}` |
| `result`    | The `LinkManifest`: `{store, manifest, linked}`        |

Failure: error code `install_failed`, exit code 1.

See [Install](../concepts/install.md).

---

## build

Executes the build targets a pattern selects.

```sh
tsflows build //...
tsflows build //packages/flow:lib
tsflows build //packages/... --jobs 4
tsflows build //... --plan
```

| Argument  | Description                        |
| --------- | ---------------------------------- |
| `pattern` | A Bazel label or recursive pattern |

Options: the [common options](#common-options) plus the execution options.

Selects targets whose rule declares the `build` kind, plans their transitive
dependency closure, and executes it.

Result with `--plan`: a [plan](#plan-shape). Otherwise a
[summary](#summary-shape).

Failures:

| Condition                   | Code             | Exit |
| --------------------------- | ---------------- | ---- |
| Planning or workspace error | `build_failed`   | 1    |
| At least one target failed  | `targets_failed` | 1    |

The `targets_failed` message reads `<n> of <m> targets failed`, with
`(<k> skipped)` appended when anything was skipped.

---

## test

Identical to [`build`](#build) except that it selects targets whose rule declares
the `test` kind.

```sh
tsflows test //packages/...
tsflows test //packages/flow:test
```

Failure codes: `test_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## lint

Identical to [`build`](#build) except that it selects targets whose rule declares
the `lint` kind.

```sh
tsflows lint //...
tsflows lint :lint
```

Failure codes: `lint_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## ci

Plans `build`, `test`, and `lint` over one pattern and executes the merged graph
once.

```sh
tsflows ci //...
tsflows ci //packages/... --plan
```

Options: the [common options](#common-options) plus the execution options.

Merging deduplicates roots, targets, and edges on label. Every plan lists
dependencies before dependents and first occurrence wins, so the merged list
keeps a valid dependency-first order. A target selected by two verbs runs once.

An exact label that does not participate in one of the three kinds is tolerated
as long as it participates in another. Any other planning error propagates. If no
kind produced a plan, the first refusal is raised, or
`no targets selected by <pattern>`.

Result with `--plan`: `{verb: "ci", pattern, roots, targets, edges, warnings}`.
Otherwise a [summary](#summary-shape) with `verb: "ci"`.

Failure codes: `ci_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## query

Lists labels or evaluates `deps(label)`. Never executes.

```sh
tsflows query //...
tsflows query //packages/flow:lib
tsflows query 'deps(//packages/engine:lib)'
```

| Argument | Description                          |
| -------- | ------------------------------------ |
| `expr`   | A label, a pattern, or `deps(label)` |

Options: the [common options](#common-options) only.

A bare label or pattern returns:

| Field     | Description                                    |
| --------- | ---------------------------------------------- |
| `query`   | The expression as given                        |
| `targets` | One `{label, rule, kinds}` per selected target |

`deps(label)` returns:

| Field          | Description                                |
| -------------- | ------------------------------------------ |
| `query`        | The expression as given                    |
| `root`         | The single root label                      |
| `dependencies` | Every label in the closure except the root |
| `edges`        | `{from, to}` pairs, `from` the dependency  |

`deps()` requires exactly one root. A recursive pattern fails with
`deps() requires one exact or default target`.

Failure: error code `query_failed`, exit code 1.

---

## graph

Prints the target graph without executing it.

```sh
tsflows graph //packages/engine:lib
tsflows graph //packages/... --mermaid
```

| Argument  | Description                        |
| --------- | ---------------------------------- |
| `pattern` | A Bazel label or recursive pattern |

| Option      | Alias | Type    | Default | Description                           |
| ----------- | ----- | ------- | ------- | ------------------------------------- |
| `--mermaid` | `-m`  | boolean | `false` | Render Mermaid instead of a text tree |

Plus the [common options](#common-options).

Planning uses the `graph` verb, which filters nothing by kind: every target the
pattern matches becomes a root.

Result:

| Field      | Description                              |
| ---------- | ---------------------------------------- |
| `pattern`  | The pattern as given                     |
| `format`   | `"mermaid"` or `"text"`                  |
| `graph`    | The rendered graph string                |
| `roots`    | The root labels                          |
| `targets`  | One `{label, rule}` per planned target   |
| `edges`    | `{from, to}` pairs                       |
| `warnings` | Planner warnings; currently always empty |

The text renderer marks a label the plan does not contain as `[external]`, and a
label already expanded under the current root as `[seen]`.

Failure: error code `graph_failed`, exit code 1.

---

## Plan shape

`--plan` prints the planner's output.

| Field      | Description                                        |
| ---------- | -------------------------------------------------- |
| `verb`     | `build`, `test`, `lint`, `graph`, `query`, or `ci` |
| `pattern`  | The pattern as given                               |
| `roots`    | The selected target labels                         |
| `targets`  | Planned targets, dependencies before dependents    |
| `edges`    | `{from, to}` pairs                                 |
| `warnings` | Currently always empty                             |

Each planned target:

| Field            | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `label`          | The target's label                                       |
| `rule`           | The rule id                                              |
| `kinds`          | The verbs the rule participates in                       |
| `attrs`          | The verb-effective attrs the executor passes to the flow |
| `dependencies`   | Direct dependency labels                                 |
| `declaredInputs` | One `{declaration, files, digest}` per declared input    |
| `cacheable`      | Whether a green result is stored                         |
| `cacheLookup`    | Always `"not-wired"`; the planner consults no cache      |
| `wouldRun`       | Always `true`                                            |
| `keyMaterial`    | `{body, inputs, layers, capabilities}`                   |
| `keyPreview`     | The sha256 content key                                   |

`cacheLookup` and `wouldRun` are stale relative to the executor, which performs
the real lookup. See [Caching](../workspace/caching.md).

`attrs`, `declaredInputs`, `cacheable`, and therefore `keyPreview` are resolved
per verb. A rule that maps one verb to a different form of its attrs has a
different key under each verb. `graph` and `query` use the declared form. See
[Verb-effective attrs](../concepts/targets-and-rules.md#verb-effective-attrs).

## Summary shape

An executed verb returns:

| Field        | Description                          |
| ------------ | ------------------------------------ |
| `verb`       | The verb that ran                    |
| `pattern`    | The pattern as given                 |
| `jobs`       | The concurrency actually used        |
| `durationMs` | Wall-clock duration of the run       |
| `counts`     | `{hit, ran, failed, skipped}`        |
| `ok`         | False when any target failed         |
| `results`    | One report per target, in plan order |

Each report:

| Field        | Description                          |
| ------------ | ------------------------------------ |
| `label`      | The target's label                   |
| `rule`       | The rule id                          |
| `status`     | `hit`, `ran`, `failed`, or `skipped` |
| `durationMs` | Time spent on this target            |
| `key`        | The content key                      |
| `error`      | Present on `failed` and `skipped`    |

| Status    | Meaning                                              |
| --------- | ---------------------------------------------------- |
| `hit`     | Answered from the result cache; the tool did not run |
| `ran`     | Executed and succeeded                               |
| `failed`  | Executed and failed                                  |
| `skipped` | Never ran because a dependency did not succeed       |

## Progress output

One status line per settled target goes to standard error, followed by a summary
line:

```
//packages/flow:lib  hit  2ms
//packages/engine:lib  ran  3.1s
//packages/engine:test  failed  0.4s  {"_tag":"tsflows-rules/ExecError", ...}
//packages/app:lib  skipped  0ms  dependency //packages/engine:test did not succeed
4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (3.6s)
```

Each field is separated by two spaces; the columns are not padded. Durations
under one second print in milliseconds. A cache write that fails prints
`tsflows: could not store <label> in the cache: <reason>` and does not fail the
run.

## Environment variables

| Variable              | Read by           | Effect                                                                                     |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `TSFLOWS_CACHE_URL`   | `cli/src/main.ts` | Optional HTTPS endpoint override for the root `RemoteCache` declaration.                   |
| `TSFLOWS_CACHE_TOKEN` | `cli/src/main.ts` | Default bearer-token variable for the HTTP cache. A declaration may name another variable. |

## Exit codes

| Code | Meaning            |
| ---- | ------------------ |
| 0    | Success            |
| 1    | Any reported error |

## Programmatic API

The `tsflows-cli` package exports the pieces the verbs are built from.

| Export                      | Kind      | Purpose                                                                                                              |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `cli`                       | value     | The configured incur CLI. `main.ts` calls `cli.serve()`.                                                             |
| `runInstall(workspaceRoot)` | function  | Plans and executes the `Install` flow under pnpm and returns the [install result](#install).                         |
| `Workspace`                 | namespace | `Workspace.make`, `resolveConfig`, `ensureGitignored`, `discoverable`, and the workspace index type.                 |
| `Planner`                   | namespace | `Planner.make(workspace, verb, pattern)`, `keyOf`, and the `Plan`, `PlannedTarget`, `KeyMaterial`, and `Edge` types. |
| `Query`                     | namespace | `Query.run(workspace, expression)` and the `Listing` and `Dependencies` result types.                                |
| `Label`                     | namespace | `Label.parse`, `Label.format`, `Label.currentPackage`, and the `Pattern` type.                                       |

`Executor`, `Cache`, `GraphOutput`, and `engine` are internal to the package and
reachable only by subpath import.

```ts
import { Planner, Workspace } from "tsflows-cli"

const workspace = await Workspace.Workspace.make("/path/to/workspace")
const plan = await Planner.make(workspace, "build", "//...")
```

## Next

- [Running targets](../workspace/running-targets.md)
- [Querying](../workspace/querying.md)
- [Workspace reference](config.md)
