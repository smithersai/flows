# Typecheck

Checks a package with `tsc --noEmit` or TypeScript build mode.

```ts
import { file, glob, Typecheck } from "tsflows-rules"

export const typecheck = Typecheck({
  srcs: [glob("src/**/*.ts"), glob("test/**/*.ts")],
  deps: [],
  tsconfig: file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd: "packages/flow"
})
```

## Attributes

| Name          | Type                    | Default  | Description                                              |
| ------------- | ----------------------- | -------- | -------------------------------------------------------- |
| `srcs`        | `Array<Input.Declared>` | required | Source declarations. Digested as key material.           |
| `deps`        | `Array<Rule.Target>`    | required | Dependency targets.                                      |
| `tsconfig`    | `Input.File`            | required | The tsconfig to check.                                   |
| `buildMode`   | `boolean`               | required | Use `tsc -b` for project references instead of `tsc -p`. |
| `incremental` | `boolean`               | required | Trust incremental build info.                            |
| `cwd`         | `string`                | `"."`    | Workspace-relative directory `tsc` runs in.              |

## Command

Plain mode:

```
pnpm exec tsc -p <tsconfig.path> --noEmit [--incremental]
```

Build mode, for project references:

```
pnpm exec tsc -b <tsconfig.path> [--force]
```

`--force` is added when `incremental` is false, so the check never trusts stale
build info.

## Inputs

Collected from the attrs: every declaration in `srcs`, plus `tsconfig`.

## Outputs

None. The rule declares no output directories, so success carries only the run
summary.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `build`                 |
| Cacheable | Always                  |
| Executes  | Yes, through `ExecLive` |

## Notes

`StandardPackage` does not emit a `Typecheck` target. Add one alongside the
macro's output when a package needs a separate check step; `API-REVIEW.md`
records whether the macro should expose it as open question 4.

## See also

- [TsBuild](ts-build.md)
- [DtsBuild](dts-build.md)
