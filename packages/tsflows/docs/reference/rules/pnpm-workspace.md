# PnpmWorkspace

Plans the real tsflows install flow for a pnpm workspace.

```ts
import { PnpmWorkspace } from "tsflows-rules"

export const nodeModules = PnpmWorkspace({
  packageManager: "pnpm@11.21.0"
})
```

Exported from the root `BUILD.ts` as `nodeModules`, the target is
`//:nodeModules`, and `//` resolves to it through the default-target search.

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `lockfile` | `string` | `"pnpm-lock.yaml"` | The lockfile path. A planner declaration: key material and a declared input. |
| `workspaceFile` | `string` | `"pnpm-workspace.yaml"` | The pnpm workspace manifest path. A planner declaration. |
| `packageManager` | `string` | required | The pinned manager spec, for example `pnpm@11.21.0`. Key material only. |

There is no `cwd` and no path to the project root. The `Install` flow reads
lockfiles and spawns the manager relative to the engine's working directory,
which the CLI moves to the workspace root.

## What it plans

The body is one call to the `Install` flow with an empty payload:

```ts
implementation: () => Install.Install.call({})
```

The flow measures the manager version, lockfile, `.npmrc`, and platform, runs a
sealed fetch into `.flows/store/pnpm`, then materializes host-local links. See
[Install](../../concepts/install.md).

## Inputs

The rule declares three inputs through its `inputs(attrs)` function:

| Declaration | Source |
| --- | --- |
| `file(lockfile)` | The `lockfile` attribute |
| `file(workspaceFile)` | The `workspaceFile` attribute |
| `file("package.json")` | Fixed: the root manifest |

## Channels

| Channel | Type |
| --- | --- |
| Success | `Install.LinkManifest`, `{store, manifest, linked}` |
| Error | `PackageManager.PackageManagerError`, `{code, message, cause?}` |

`code` is one of `command_failed`, `environment_mismatch`, `lockfile_unreadable`,
`manifest_unreadable`, `unsafe_configuration`, or `unsupported`.

## Key material

| Field | Value |
| --- | --- |
| `layers` | `["package-manager:pnpm"]` |
| `capabilities` | `["fs:read", "fs:write", "proc:spawn"]` |

## Status

| | |
| --- | --- |
| Kinds | `run` |
| Cacheable | Always, at the planner level |
| Executes | Yes. The executor merges `Install.layer`, the registered install flow, and the pnpm package-manager layer. |

The CLI has no `run` verb, so the target is never selected as a root. It executes
when a selected target depends on it. `tsflows install` runs the same flow
directly without going through this target.

## Known duplication

The `lockfile`, `workspaceFile`, and `packageManager` attributes are planner
declarations, while the `Install` flow discovers the manager's lockfile through
its layer. `API-REVIEW.md` records that this should be reconciled once the
install surface is final.

## See also

- [Install](../../concepts/install.md)
- [CLI install verb](../cli.md#install)
