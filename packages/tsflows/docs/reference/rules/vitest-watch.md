# VitestWatch

Runs an interactive `vitest watch` session.

```ts
import { VitestWatch, file, glob } from "tsflows-rules"

export const testWatch = VitestWatch({
  tests: [glob("test/**/*.test.ts")],
  sources: [glob("src/**/*.ts")],
  deps: [lib],
  config: file("vitest.config.ts"),
  environment: "node",
  cwd: "packages/flow"
})
```

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `tests` | `Array<Input.Declared>` | required | Test file declarations. Startup key material only. |
| `sources` | `Array<Input.Declared>` | required | Source declarations. Startup key material only. |
| `deps` | `Array<Rule.Target>` | required | Dependency targets. |
| `config` | `Input.File \| null` | required | The Vitest config, or `null` to pass no `--config`. |
| `environment` | `string` | required | The Vitest environment. |
| `cwd` | `string` | `"."` | Workspace-relative directory the runner starts in. |

## Command

```
pnpm exec vitest watch [--config <config.path>] --environment <environment>
```

The spawn is a pass-through. The node succeeds when the session exits cleanly,
and interrupting the fiber kills the process.

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`. They describe startup invalidation only; a watch
session re-runs tests itself.

## Channels

| Channel | Type |
| --- | --- |
| Success | `Exec.Result` |
| Error | `Exec.ExecError` |

## Status

| | |
| --- | --- |
| Kinds | `run` |
| Cacheable | Never; it is a long-lived process |
| Executes | Yes, through `ExecLive`, but only as a dependency |

The CLI has no `run` verb, so a `VitestWatch` target is never selected as a root.
If a selected target depends on one, the executor runs it and the session holds
its concurrency slot until it exits. Do not put a watch target in a dependency
chain that `build`, `test`, `lint`, or `ci` reaches.

## See also

- [Vitest](vitest.md)
- [Dev](dev.md) for any other long-lived process
- [Running targets](../../workspace/running-targets.md)
