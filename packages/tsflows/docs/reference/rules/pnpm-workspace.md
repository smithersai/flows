# PnpmWorkspace

Runs the tsflows install flow for a pnpm workspace.

```ts
import { PnpmWorkspace } from "tsflows-rules"

export const nodeModules = PnpmWorkspace({
  packageManager: "pnpm@11.21.0"
})
```

Exported from the root as `nodeModules`, the label is `//:nodeModules` and `//`
resolves to it through the default-target search.

## Attributes

| Name             | Type         | Default                       | Description                                      |
| ---------------- | ------------ | ----------------------------- | ------------------------------------------------ |
| `lockfile`       | `Input.File` | `file("pnpm-lock.yaml")`      | Planner-declared lockfile input                  |
| `workspaceFile`  | `Input.File` | `file("pnpm-workspace.yaml")` | Planner-declared workspace-manifest input        |
| `packageJson`    | `Input.File` | `file("package.json")`        | Planner-declared root package-manifest input     |
| `packageManager` | `string`     | required                      | Pinned tool identity, for example `pnpm@11.21.0` |

The file attributes must be real `Input.file(...)` values when overridden;
plain strings are rejected. There is no `cwd`. Execution is anchored to the
canonical workspace root by the package-manager service.

## What it plans

The rule body is one call to the install flow with an empty first-round payload:

```ts
implementation: ;
;(() => Install.Install.call({}))
```

The flow measures the live pnpm version, lockfile, project `.npmrc`, and
platform; fetches into `.flows/store/pnpm`; and always reconciles
`node_modules` offline. Measure, fetch, and link all use `expected` boundaries
and are not admitted to the cross-run engine cache.

The rule's own planner key still includes the three declared file inputs and
the package-manager identity. This duplicates part of the install flow's
runtime measurement intentionally until the authoring and runtime contracts
can share one declaration without weakening either boundary.

## Channels

| Channel | Type                                                            |
| ------- | --------------------------------------------------------------- |
| Success | `Install.LinkManifest`, `{store, manifest, linked}`             |
| Error   | `PackageManager.PackageManagerError`, `{code, message, cause?}` |

Error `code` is one of `command_failed`, `environment_mismatch`,
`lockfile_unreadable`, `manifest_unreadable`, `unsafe_configuration`, or
`unsupported`.

## Status

| Property  | Value                                                                    |
| --------- | ------------------------------------------------------------------------ |
| Kinds     | `run`                                                                    |
| Cacheable | No; a JSON hit must never skip local link reconciliation                 |
| Executes  | Yes, as a `run` root or dependency, under the pnpm package-manager layer |

The outer target is explicitly `cache: false`. Its `LinkManifest` is not enough
to restore either `node_modules` or the manager store, so caching that wrapper
would allow a JSON hit to skip the entire nested install flow.

`tsflows install` runs the same flow directly and requires the default `.flows`
cache directory because the store boundary is fixed there.

## See also

- [Install](../../concepts/install.md)
- [CLI install verb](../cli.md#install)
