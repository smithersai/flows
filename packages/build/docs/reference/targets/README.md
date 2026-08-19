# Target catalog

Every target in `@smthrs/targets`. Each page lists the target's attributes, its
declared inputs, its success and error channels, and whether it executes today.

Import a target by name from the package root:

```ts
import { Smithers } from "@smthrs/targets"
```

## Execution status

The CLI executor supplies the shared exec, generated-file write/check,
workflow-contract, documentation-parity, filegroup, LLM-review,
package-manifest, output-capture, scaffold, and install implementations. It
deliberately does not supply the irreversible-exec implementation, so a target
that publishes externally or applies release versioning fails at interpretation
with an `unresolved_action` refusal.

**Executes** means the target's plan runs through its declared CLI verb, either
as a root or as a dependency. **Plans only** means the target is
planned, queried, and graphed normally, but executing it fails on a missing
action implementation. No catalog target ends in `NotImplemented`; that machinery
exists for future additions and is unused. See
[Running targets](../../workspace/running-targets.md#what-executes).

**Cacheable** is the target's own `cache` decision. Targets are cacheable by
default; **Never** means the rule declares `cache: false` because replaying its
result would be wrong rather than merely stale. A hit for a target that declares
outputs restores those outputs from the content-addressed store. See
[Cacheability](../../workspace/caching.md#cacheability).

## Build

| Target                         | Kinds   | Cacheable    | Status   | Summary                                                                        |
| ------------------------------ | ------- | ------------ | -------- | ------------------------------------------------------------------------------ |
| [TsBuild](ts-build.md)         | `build` | Always       | Executes | Builds a JavaScript distribution with `tsc -p` or `tsup`.                      |
| [DtsBuild](dts-build.md)       | `build` | Always       | Executes | Emits type declarations with `tsc --emitDeclarationOnly` or `tsup --dts-only`. |
| [Typecheck](typecheck.md)      | `build` | Always       | Executes | Checks a package with `tsc --noEmit` or TypeScript build mode.                 |
| [ToolBuild](tool-build.md)     | `build` | `cache` attr | Executes | Runs an arbitrary command for a non-TypeScript toolchain.                      |
| [TypedocDocs](typedoc-docs.md) | `build` | Always       | Executes | Generates API documentation with TypeDoc.                                      |

## Test

| Target                               | Kinds  | Cacheable | Status   | Summary                                         |
| ------------------------------------ | ------ | --------- | -------- | ----------------------------------------------- |
| [Vitest](vitest.md)                  | `test` | Always    | Executes | Runs `vitest run` over a declared test set.     |
| [VitestCoverage](vitest-coverage.md) | `test` | Always    | Executes | Runs `vitest run` with coverage and thresholds. |
| [VitestWatch](vitest-watch.md)       | `run`  | Never     | Executes | Runs an interactive `vitest watch` session.     |

## Lint

| Target                         | Kinds  | Cacheable | Status   | Summary                                                                               |
| ------------------------------ | ------ | --------- | -------- | ------------------------------------------------------------------------------------- |
| [EsLint](es-lint.md)           | `lint` | Never     | Executes | Runs ESLint over declared source sets with a flat config.                             |
| [BiomeCheck](biome-check.md)   | `lint` | Always    | Executes | Runs `biome check` and `biome format` without writing files.                          |
| [DepsLint](deps-lint.md)       | `lint` | Always    | Executes | Checks dependency declarations with knip or depcheck.                                 |
| [PackageLint](package-lint.md) | `lint` | Always    | Executes | Checks the published package surface with publint and attw.                           |
| [LlmLint](llm-lint.md)         | `lint` | Never     | Executes | Reviews changed files with a model against a rubric, through the claude or codex CLI. |

## Generation

| Target                                  | Kinds           | Cacheable                          | Status   | Summary                                                                      |
| --------------------------------------- | --------------- | ---------------------------------- | -------- | ---------------------------------------------------------------------------- |
| [SortPackageJson](sort-package-json.md) | `build`, `lint` | Never                              | Executes | Validates or rewrites `package.json` key ordering.                           |
| [PackageJson](package-json-gen.md)      | `lint` / `run`  | Check only                         | Executes | Expands a typed manifest declaration into check, write, and refresh targets. |
| [GithubCiGen](github-ci-gen.md)         | `build`, `lint` | Effective `contract`/`check` modes | Executes | Generates the GitHub Actions CI workflow from attrs.                         |

## Documentation

| Target                       | Kinds  | Cacheable | Status   | Summary                                                |
| ---------------------------- | ------ | --------- | -------- | ------------------------------------------------------ |
| [DocsParity](docs-parity.md) | `docs` | Always    | Executes | Requires a substantive README beside a package's code. |

`PackageJson` uses separate targets for checking and source-tree writes.
`GithubCiGen` maps its `lint` verb to the drift-check form. See [Verb-effective attrs](../../concepts/targets.md#verb-effective-attrs).

## Install, release, and processes

| Target                             | Kinds | Cacheable | Status                                  | Summary                                                            |
| ---------------------------------- | ----- | --------- | --------------------------------------- | ------------------------------------------------------------------ |
| [PnpmWorkspace](pnpm-workspace.md) | `run` | Never     | Executes                                | Runs the smthrs install flow for a pnpm workspace.                 |
| [NewPackage](new-package.md)       | `run` | Never     | Executes                                | Scaffolds one package named with the invocation's `--name` option. |
| [Changesets](changesets.md)        | `run` | Never     | `status` executes; `version` plans only | Reports Changesets status or applies versioning.                   |
| [NpmPublish](npm-publish.md)       | `run` | Never     | Plans only                              | Publishes a package to an npm registry.                            |
| [JsrPublish](jsr-publish.md)       | `run` | Never     | Plans only                              | Publishes a package to JSR.                                        |
| [Clean](clean.md)                  | `run` | Never     | Executes                                | Deletes explicitly declared generated paths.                       |
| [Dev](dev.md)                      | `run` | Never     | Executes                                | Runs a long-lived development or watch command.                    |

## File sets

| Target                    | Kinds | Cacheable | Status                   | Summary                                                       |
| ------------------------- | ----- | --------- | ------------------------ | ------------------------------------------------------------- |
| [Filegroup](filegroup.md) | none  | Always    | Executes as a dependency | Names a set of files under one label, composing transitively. |

A group joins no verb, so it is never selected as a root and never performs work
under `build`, `test`, or `lint`. It is still addressable by label, listed by
`query`, and traversed by `deps(...)`.

## Macros

| Name                                                                     | Summary                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [StandardPackage](standard-package.md)                                   | Expands one conventional TypeScript package into `lib`, `test`, and `lint`. |
| [PackageJsonTemplate](package-json-gen.md#templates-and-merge-semantics) | Holds inert workspace-wide manifest defaults.                               |

## Authoring surface

These modules are not targets. They are documented elsewhere.

| Module            | Documented in                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `Target`          | [Writing targets](../../extending/writing-targets.md), [Targets and targets](../../concepts/targets.md) |
| `Input`           | [Inputs](../../concepts/inputs.md)                                                                      |
| `Exec`            | [Actions and boundaries](../../concepts/actions-and-boundaries.md)                                      |
| `Workspace`       | [Workspace reference](../config.md)                                                                     |
| `PackageDefaults` | [Default targets](../../extending/default-targets.md)                                                   |

## Conventions shared by every tool-running target

- **`cwd`** is the workspace-relative directory the tool starts in. It defaults
  to `"."`, the workspace root. Package-level targets pass their own directory.
  [Dev](dev.md) declares `cwd` without a default, so it is required there.
  [TypedocDocs](typedoc-docs.md), [Changesets](changesets.md),
  [NpmPublish](npm-publish.md), [JsrPublish](jsr-publish.md), and
  [PnpmWorkspace](pnpm-workspace.md) declare no `cwd` at all. `TypedocDocs` and
  `Changesets` run at the workspace root, the publish targets run in the directory
  of their declared manifest, and `PnpmWorkspace` generates its file at the
  workspace root.
- **Tools resolve through `PackageManager.exec`** of the declared package
  manager, so the manager is declared key material rather than a hardcoded
  constant. `ToolBuild`, `Dev`, and the runtime-evaluated helper steps are the
  exceptions.
- **Paths in attrs resolve from `cwd` when the tool runs**, and from the
  declaring package when the planner digests them. A `//`-prefixed path resolves
  from the workspace root in both cases.
- **Success is `Exec.Result`**, `{exitCode, stdout, stderr}`, unless
  the target declares something richer. Producing build targets use `Outputs`.
- **Errors are `Exec.ExecError`**, `{argv, cwd, exitCode, stderr}`, with
  `exitCode: -1` when the spawn itself failed.
