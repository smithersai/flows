# TsBuild

Builds a JavaScript distribution for a TypeScript package with `tsc -p` or
`tsup`.

```ts
import { TsBuild, file, glob } from "tsflows-rules"

export const lib = TsBuild({
  srcs: [glob("src/**/*.ts")],
  entries: ["src/index.ts"],
  deps: [],
  tsconfig: file("tsconfig.json"),
  tool: "tsc",
  format: "dual",
  outDir: "dist",
  external: [],
  cwd: "packages/flow"
})
```

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `srcs` | `Array<Input.Declared>` | required | Source declarations. Digested as key material. |
| `entries` | `Array<string>` | required | Entry points. Passed to `tsup`; key material only for `tsc`. |
| `deps` | `Array<Rule.Target>` | required | Dependency targets. |
| `tsconfig` | `Input.File` | required | The tsconfig the build uses. |
| `tool` | `"tsup" \| "tsc"` | required | Which builder to run. |
| `format` | `"esm" \| "cjs" \| "dual"` | required | Output module format. Passed to `tsup`; key material only for `tsc`. |
| `outDir` | `string` | required | Output directory, relative to `cwd`. Also the captured output path. |
| `external` | `Array<string>` | required | Packages left unbundled. Passed to `tsup`; key material only for `tsc`. |
| `cwd` | `string` | `"."` | Workspace-relative directory the tool runs in. |

## Command

For `tsc`, the tsconfig owns every emit option:

```
pnpm exec tsc -p <tsconfig.path>
```

For `tsup`, the attributes map to flags:

```
pnpm exec tsup <entries...> --format <esm|cjs|esm,cjs> --out-dir <outDir> [--external <name>]...
```

`format: "dual"` becomes `esm,cjs`.

## Inputs

Collected from the attrs: every declaration in `srcs`, plus `tsconfig`.

## Outputs

Success is `Outputs`:

```ts
{ outputs: Array<{ path: string, fileCount: number, contentDigest: string }> }
```

The plan ends with the shared output-capture step, which digests `outDir` after
the build. Capture is sequenced directly behind the producing step, so the
engine settles the build first. `outDir` is a required output: a build that exits
zero without creating it fails the target.

## Channels

| Channel | Type |
| --- | --- |
| Success | `Outputs` |
| Error | `Exec.ExecError` |

## Status

| | |
| --- | --- |
| Kinds | `build` |
| Cacheable | Always |
| Executes | Yes, through `ExecLive` |

## See also

- [DtsBuild](dts-build.md) for declaration-only emit
- [Typecheck](typecheck.md) for checking without emit
- [ToolBuild](tool-build.md) for other toolchains
- [StandardPackage](standard-package.md), which emits a `TsBuild` `lib` target
