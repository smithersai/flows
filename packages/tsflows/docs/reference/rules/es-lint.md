# EsLint

Runs ESLint over declared source sets with a flat config.

```ts
import { EsLint, file, glob } from "tsflows-rules"

export const lint = EsLint({
  sources: [glob("src/**/*.ts")],
  deps: [],
  configs: [file("eslint.config.js"), file("//eslint.jsdoc.js")],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/flow"
})
```

## Attributes

| Name          | Type                    | Default  | Description                                                                                              |
| ------------- | ----------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `sources`     | `Array<Input.Declared>` | required | What to lint. Globs pass through to ESLint as patterns.                                                  |
| `deps`        | `Array<Rule.Target>`    | required | Dependency targets. Usually empty: linting sources needs nothing built.                                  |
| `configs`     | `Array<Input.File>`     | required | Flat configs. The first is passed as `--config`; the rest are key material for files the config imports. |
| `maxWarnings` | `number`                | required | The warning budget, passed as `--max-warnings`.                                                          |
| `fix`         | `boolean`               | required | Apply autofixes. Makes the target non-cacheable.                                                         |
| `cwd`         | `string`                | `"."`    | Workspace-relative directory the tool runs in.                                                           |

## Command

```
pnpm exec eslint [--config <configs[0].path>] --max-warnings <maxWarnings> [--fix] <patterns...>
```

ESLint expands glob patterns itself, so the source declarations reduce to
arguments as follows:

| Declaration | Contributes            |
| ----------- | ---------------------- |
| `Glob`      | its `pattern` verbatim |
| `File`      | its `path`             |
| `GitDiff`   | nothing                |

## Inputs

Collected from the attrs: every declaration in `sources`, plus every entry in
`configs`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `lint`                  |
| Cacheable | When `fix` is false     |
| Executes  | Yes, through `ExecLive` |

## Notes

`StandardPackage` lints the source glob only, not tests. Its flat config declares
no coverage for test files, and ESLint 9 fails on a pattern whose matches are all
unconfigured. A package whose config does cover tests can pass both globs, as
`packages/flow/BUILD.ts` does.

## See also

- [BiomeCheck](biome-check.md) for the Biome equivalent
- [StandardPackage](standard-package.md), which emits an `EsLint` `lint` target
