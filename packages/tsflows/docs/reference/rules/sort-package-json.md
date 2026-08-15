# SortPackageJson

Validates or rewrites `package.json` key ordering with `sort-package-json`.

```ts
import { SortPackageJson, file } from "tsflows-rules"

export const manifestOrder = SortPackageJson({
  manifests: [file("package.json")],
  deps: [],
  check: true,
  cwd: "packages/flow"
})
```

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `manifests` | `Array<Input.File>` | required | The manifests to sort. With none declared, the tool sorts the `package.json` in `cwd`. |
| `deps` | `Array<Rule.Target>` | required | Dependency targets. |
| `check` | `boolean` | required | Report only instead of rewriting. |
| `cwd` | `string` | `"."` | Workspace-relative directory the tool runs in. |

## Command

```
pnpm exec sort-package-json [--check] <manifests...>
```

With `check: true` the run only reports, which suits the `lint` verb. Without it
the run rewrites the manifests in place, which suits the `build` verb and is not
cacheable.

## Inputs

Collected from the attrs: every entry in `manifests`.

## Channels

| Channel | Type |
| --- | --- |
| Success | `Exec.Result` |
| Error | `Exec.ExecError` |

## Status

| | |
| --- | --- |
| Kinds | `build`, `lint` |
| Cacheable | When `check` is true |
| Executes | Yes, through `ExecLive` |

Because the rule declares both kinds, one target is selected by both
`tsflows build` and `tsflows lint`. `tsflows ci` merges the two plans and runs it
once.

Under `lint`, `SortPackageJson` forces `check: true`, so lint never rewrites a
manifest. Under `build`, it uses the declared value. `PackageJson` instead
exposes separate check and write targets.

## See also

- [PackageJson](package-json-gen.md) for declaring and checking a manifest
- [PackageLint](package-lint.md)
