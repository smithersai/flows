# Rule catalog

Every rule in `tsflows-rules`. Each page lists the rule's attributes, its
declared inputs, its success and error channels, and whether it executes today.

Import a rule by name from the package root:

```ts
import { EsLint, StandardPackage, TsBuild, Vitest } from "tsflows-rules"
```

## Execution status

The CLI executor supplies the shared exec, generated-file write/check,
workflow-contract, documentation-parity, filegroup, LLM-review,
package-manifest, output-capture, scaffold, and install implementations. It
deliberately does not supply the irreversible-exec implementation, so a target
that publishes externally or applies release versioning fails at interpretation
with an `unresolved_action` refusal.

**Executes** means the rule's plan runs through its declared CLI verb, either
as a root or as a dependency. **Plans only** means the target is
planned, queried, and graphed normally, but executing it fails on a missing
action implementation. No catalog rule ends in `NotImplemented`; that machinery
exists for future additions and is unused. See
[Running targets](../../workspace/running-targets.md#what-executes).

## Build

| Rule                           | Kinds   | Cacheable    | Status   | Summary                                                                        |
| ------------------------------ | ------- | ------------ | -------- | ------------------------------------------------------------------------------ |
| [TsBuild](ts-build.md)         | `build` | Never        | Executes | Builds a JavaScript distribution with `tsc -p` or `tsup`.                      |
| [DtsBuild](dts-build.md)       | `build` | Never        | Executes | Emits type declarations with `tsc --emitDeclarationOnly` or `tsup --dts-only`. |
| [Typecheck](typecheck.md)      | `build` | Never        | Executes | Checks a package with `tsc --noEmit` or TypeScript build mode.                 |
| [ToolBuild](tool-build.md)     | `build` | `cache` attr | Executes | Runs an arbitrary command for a non-TypeScript toolchain.                      |
| [TypedocDocs](typedoc-docs.md) | `build` | Never        | Executes | Generates API documentation with TypeDoc.                                      |

## Test

| Rule                                 | Kinds  | Cacheable | Status   | Summary                                         |
| ------------------------------------ | ------ | --------- | -------- | ----------------------------------------------- |
| [Vitest](vitest.md)                  | `test` | Never     | Executes | Runs `vitest run` over a declared test set.     |
| [VitestCoverage](vitest-coverage.md) | `test` | Never     | Executes | Runs `vitest run` with coverage and thresholds. |
| [VitestWatch](vitest-watch.md)       | `run`  | Never     | Executes | Runs an interactive `vitest watch` session.     |

## Lint

| Rule                           | Kinds  | Cacheable | Status   | Summary                                                                               |
| ------------------------------ | ------ | --------- | -------- | ------------------------------------------------------------------------------------- |
| [EsLint](es-lint.md)           | `lint` | Never     | Executes | Runs ESLint over declared source sets with a flat config.                             |
| [BiomeCheck](biome-check.md)   | `lint` | Never     | Executes | Runs `biome check` and `biome format` without writing files.                          |
| [DepsLint](deps-lint.md)       | `lint` | Never     | Executes | Checks dependency declarations with knip or depcheck.                                 |
| [PackageLint](package-lint.md) | `lint` | Never     | Executes | Checks the published package surface with publint and attw.                           |
| [LlmLint](llm-lint.md)         | `lint` | Never     | Executes | Reviews changed files with a model against a rubric, through the claude or codex CLI. |

## Generation

| Rule                                    | Kinds           | Cacheable                          | Status   | Summary                                                                      |
| --------------------------------------- | --------------- | ---------------------------------- | -------- | ---------------------------------------------------------------------------- |
| [SortPackageJson](sort-package-json.md) | `build`, `lint` | Never                              | Executes | Validates or rewrites `package.json` key ordering.                           |
| [PackageJson](package-json-gen.md)      | `lint` / `run`  | Check only                         | Executes | Expands a typed manifest declaration into check, write, and refresh targets. |
| [GithubCiGen](github-ci-gen.md)         | `build`, `lint` | Effective `contract`/`check` modes | Executes | Generates the GitHub Actions CI workflow from attrs.                         |

## Documentation

| Rule                         | Kinds  | Cacheable | Status   | Summary                                                |
| ---------------------------- | ------ | --------- | -------- | ------------------------------------------------------ |
| [DocsParity](docs-parity.md) | `docs` | Always    | Executes | Requires a substantive README beside a package's code. |

`PackageJson` uses separate targets for checking and source-tree writes.
`GithubCiGen` maps its `lint` verb to the drift-check form. See [Verb-effective attrs](../../concepts/targets-and-rules.md#verb-effective-attrs).

## Install, release, and processes

| Rule                               | Kinds | Cacheable | Status                                  | Summary                                                            |
| ---------------------------------- | ----- | --------- | --------------------------------------- | ------------------------------------------------------------------ |
| [PnpmWorkspace](pnpm-workspace.md) | `run` | Never     | Executes                                | Runs the tsflows install flow for a pnpm workspace.                |
| [NewPackage](new-package.md)       | `run` | Never     | Executes                                | Scaffolds one package named with the invocation's `--name` option. |
| [Changesets](changesets.md)        | `run` | Never     | `status` executes; `version` plans only | Reports Changesets status or applies versioning.                   |
| [NpmPublish](npm-publish.md)       | `run` | Never     | Plans only                              | Publishes a package to an npm registry.                            |
| [JsrPublish](jsr-publish.md)       | `run` | Never     | Plans only                              | Publishes a package to JSR.                                        |
| [Clean](clean.md)                  | `run` | Never     | Executes                                | Deletes explicitly declared generated paths.                       |
| [Dev](dev.md)                      | `run` | Never     | Executes                                | Runs a long-lived development or watch command.                    |

## File sets

| Rule                      | Kinds | Cacheable | Status                   | Summary                                                       |
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

These modules are not rules. They are documented elsewhere.

| Module        | Documented in                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `Rule`        | [Writing rules](../../extending/writing-rules.md), [Targets and rules](../../concepts/targets-and-rules.md) |
| `Input`       | [Inputs](../../concepts/inputs.md)                                                                          |
| `Exec`        | [Actions and boundaries](../../concepts/actions-and-boundaries.md)                                          |
| `Workspace`   | [Workspace reference](../config.md)                                                                         |
| `DefaultRule` | [Default rules](../../extending/default-rules.md)                                                           |

## Conventions shared by every tool-running rule

- **`cwd`** is the workspace-relative directory the tool starts in. It defaults
  to `"."`, the workspace root. Package-level targets pass their own directory.
  [Dev](dev.md) declares `cwd` without a default, so it is required there.
  [TypedocDocs](typedoc-docs.md), [Changesets](changesets.md),
  [NpmPublish](npm-publish.md), [JsrPublish](jsr-publish.md), and
  [PnpmWorkspace](pnpm-workspace.md) declare no `cwd` at all. `TypedocDocs` and
  `Changesets` run at the workspace root, the publish rules run in the directory
  of their declared manifest, and `PnpmWorkspace` runs the install flow from the
  canonical workspace root supplied by the executor.
- **Tools resolve through `pnpm exec`**, matching the pnpm workspace install
  target. `ToolBuild`, `Dev`, and the internal `node -e` helper steps are the
  exceptions.
- **Paths in attrs resolve from `cwd` when the tool runs**, and from the
  declaring package when the planner digests them. A `//`-prefixed path resolves
  from the workspace root in both cases.
- **Success is `Exec.Result`**, `{exitCode, stdout, stderr}`, unless
  the rule declares something richer. Producing build rules use `Outputs`.
- **Errors are `Exec.ExecError`**, `{argv, cwd, exitCode, stderr}`, with
  `exitCode: -1` when the spawn itself failed.
