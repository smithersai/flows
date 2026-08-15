# VitestCoverage

Runs `vitest run` with coverage enabled and declares the report directory.

```ts
import { VitestCoverage, file, glob } from "tsflows-rules"

export const coverage = VitestCoverage({
  tests: [glob("test/**/*.test.ts")],
  sources: [glob("src/**/*.ts")],
  deps: [lib],
  config: file("vitest.config.ts"),
  provider: "v8",
  reportsDirectory: "coverage",
  thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
  cwd: "packages/flow"
})
```

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `tests` | `Array<Input.Declared>` | required | Test file declarations. |
| `sources` | `Array<Input.Declared>` | required | Source declarations. |
| `deps` | `Array<Rule.Target>` | required | Dependency targets. |
| `config` | `Input.File \| null` | required | The Vitest config, or `null` to pass no `--config`. |
| `provider` | `"v8" \| "istanbul"` | required | Coverage provider. |
| `reportsDirectory` | `string` | required | Where coverage reports are written, relative to `cwd`. |
| `thresholds` | `{branches, functions, lines, statements}` | required | Minimum coverage percentages. All four are numbers and all four are required. |
| `cwd` | `string` | `"."` | Workspace-relative directory the runner starts in. |

## Command

```
pnpm exec vitest run [--config <config.path>] \
  --coverage.enabled=true \
  --coverage.provider=<provider> \
  --coverage.reportsDirectory=<reportsDirectory> \
  --coverage.thresholds.branches=<n> \
  --coverage.thresholds.functions=<n> \
  --coverage.thresholds.lines=<n> \
  --coverage.thresholds.statements=<n>
```

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`.

## Channels

| Channel | Type |
| --- | --- |
| Success | `CoverageReport` |
| Error | `Exec.ExecError` |

```ts
CoverageReport = { run: Exec.Result, reportsDirectory: string }
```

The success value carries `reportsDirectory` so a downstream target can consume
the written reports.

## Status

| | |
| --- | --- |
| Kinds | `test` |
| Cacheable | Always |
| Executes | Yes, through `ExecLive` |

## See also

- [Vitest](vitest.md)
- [VitestWatch](vitest-watch.md)
