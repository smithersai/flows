# Vitest

Runs a non-watch `vitest run` over a declared test set.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const test = Smithers.Vitest({
  packageManager,
  tests: [Smithers.glob("test/**/*")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/flow"
})
```

## Attributes

| Name              | Type                            | Default  | Description                                                                                |
| ----------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager`  | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `tests`           | `Array<Input.Declared>`         | required | Test tree declarations. Digested as key material. Declare the whole test directory.        |
| `sources`         | `Array<Input.Declared>`         | required | Source declarations, so a source edit re-keys the run.                                     |
| `deps`            | `Array<Target.Target>`          | required | Dependency targets, usually the package's `lib`.                                           |
| `config`          | `Input.File \| null`            | required | The Vitest config, or `null` to pass no `--config`.                                        |
| `environment`     | `string`                        | required | The Vitest environment, for example `node` or `jsdom`.                                     |
| `passWithNoTests` | `boolean`                       | required | Succeed when the suite matches no files.                                                   |
| `cwd`             | `string`                        | `"."`    | Workspace-relative directory the runner starts in.                                         |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```
pnpm exec vitest run [--config <config.path>] --environment <environment> [--passWithNoTests]
```

The target passes no file arguments. Vitest discovers test files itself; the
declared `tests` control the cache key.

Declare the whole test directory, not the `.test.ts` spec files alone. Vitest
imports harness modules and reads fixtures of any extension, and only a declared
read is key material. This target is cacheable, so a declaration narrowed to the
spec files reports the previous run's green result after a harness or fixture
edit. `StandardPackage` and the config-file path form both declare
`test/**/*` for this reason.

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `test`                  |
| Cacheable | Yes, by default         |
| Executes  | Yes, through `ExecLive` |

A hit is a full skip: this target declares no outputs. The declared toolchain
and the lockfile digest are key material; the installed tool binary is not, so
an uninstalled or partially installed lockfile keys the same as an installed
one. See [Cacheability](../../workspace/caching.md#cacheability).

## See also

- [VitestCoverage](vitest-coverage.md) for coverage and thresholds
- [VitestWatch](vitest-watch.md) for an interactive session
- [StandardPackage](standard-package.md), which emits a `Vitest` `test` target
