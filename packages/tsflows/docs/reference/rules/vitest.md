# Vitest

Runs a non-watch `vitest run` over a declared test set.

```ts
import { file, glob, Vitest } from "tsflows-rules"

export const test = Vitest({
  tests: [glob("test/**/*.test.ts")],
  sources: [glob("src/**/*.ts")],
  deps: [lib],
  config: file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/flow"
})
```

## Attributes

| Name              | Type                    | Default  | Description                                            |
| ----------------- | ----------------------- | -------- | ------------------------------------------------------ |
| `tests`           | `Array<Input.Declared>` | required | Test file declarations. Digested as key material.      |
| `sources`         | `Array<Input.Declared>` | required | Source declarations, so a source edit re-keys the run. |
| `deps`            | `Array<Rule.Target>`    | required | Dependency targets, usually the package's `lib`.       |
| `config`          | `Input.File \| null`    | required | The Vitest config, or `null` to pass no `--config`.    |
| `environment`     | `string`                | required | The Vitest environment, for example `node` or `jsdom`. |
| `passWithNoTests` | `boolean`               | required | Succeed when the suite matches no files.               |
| `cwd`             | `string`                | `"."`    | Workspace-relative directory the runner starts in.     |

## Command

```
pnpm exec vitest run [--config <config.path>] --environment <environment> [--passWithNoTests]
```

The rule passes no file arguments. Vitest discovers test files itself; the
declared `tests` control the cache key.

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                              |
| --------- | ------------------------------------------------------------ |
| Kinds     | `test`                                                       |
| Cacheable | Never; the executable toolchain is not complete key material |
| Executes  | Yes, through `ExecLive`                                      |

## See also

- [VitestCoverage](vitest-coverage.md) for coverage and thresholds
- [VitestWatch](vitest-watch.md) for an interactive session
- [StandardPackage](standard-package.md), which emits a `Vitest` `test` target
