# PackageLint

Checks the published package surface with publint, and optionally checks the
packed tarball's types with arethetypeswrong.

```ts
import { PackageLint, file, glob } from "tsflows-rules"

export const packageLint = PackageLint({
  packageJson: file("package.json"),
  artifacts: [glob("dist/**/*")],
  deps: [lib],
  strict: true,
  pack: true,
  attw: true,
  cwd: "packages/flow"
})
```

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `packageJson` | `Input.File` | required | The manifest being checked. Key material. |
| `artifacts` | `Array<Input.Declared>` | required | Built output declarations, so a rebuild re-keys the check. |
| `deps` | `Array<Rule.Target>` | required | Dependency targets, usually the build that produced the artifacts. |
| `strict` | `boolean` | required | Report publint warnings as errors. |
| `pack` | `boolean` | required | Let publint pack the package. When false it reads the directory as-is. |
| `attw` | `boolean` | required | Also run arethetypeswrong. |
| `cwd` | `string` | `"."` | Workspace-relative directory both tools lint. |

## Commands

Up to two runs, both from `cwd`:

```
pnpm exec publint [--strict] [--pack false]
pnpm exec attw --pack .
```

`attw --pack .` packs the package and checks the resulting tarball's types. When
`attw` is false, that half of the result is `null`.

## Inputs

Collected from the attrs: `packageJson`, plus every declaration in `artifacts`.

The built files arrive through the `deps` edges. Declaring them as `artifacts`
too is what makes their content part of this target's key.

## Channels

| Channel | Type |
| --- | --- |
| Success | `PackageReport` |
| Error | `Exec.ExecError` |

```ts
PackageReport = { publint: Exec.Result, attw: Exec.Result | null }
```

## Status

| | |
| --- | --- |
| Kinds | `lint` |
| Cacheable | Always |
| Executes | Yes, through `ExecLive` |

## See also

- [DepsLint](deps-lint.md) for dependency declarations
- [PackageJson](package-json-gen.md) for declaring and checking the manifest
