# Lockfile

Generates the lockfile for the declared package manager.

```ts
import { Smithers } from "@smthrs/targets"

const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
export const workspace = Smithers.PnpmWorkspace({ packageManager, packages: ["packages/*"] })

export const lockfile = Smithers.Lockfile({ packageManager, workspace })
```

A lockfile is a build output: derived, deterministic given the manifests and
the registry state it pins, and never hand-edited. Declaring it as a target
says so, and gives [Install](./install.md) something to depend on.

## Why this is separate from Install

A target cannot be keyed on a file it produces. The key would be computed from
the old bytes and then invalidated by the target's own run. So resolution writes
the lockfile here, and installation reads it there, where it is ordinary
declared content.

## Attributes

| Name             | Type               | Default                             | Description                                     |
| ---------------- | ------------------ | ----------------------------------- | ----------------------------------------------- |
| `packageManager` | `PackageManager`   | required                            | The declared manager                            |
| `workspace`      | `Target \| null`   | `null`                              | The workspace-definition target, when generated |
| `manifest`       | `Target \| null`   | `null`                              | The root-manifest target, when generated        |
| `manifests`      | `Input.Declared[]` | `[glob("packages/*/package.json")]` | Every manifest whose dependencies it pins       |

The manifests are declared inputs: their content is what resolution reads, so
their digests are this target's key material.

## What it runs

The manager's resolve-only install, with lifecycle scripts refused:

```text
pnpm install --lockfile-only --ignore-scripts
npm  install --package-lock-only --ignore-scripts
yarn install --mode=update-lockfile --mode=skip-build
bun  install --lockfile-only --ignore-scripts
```

Resolution has no reason to execute package code, and a lifecycle script that
runs during resolution can change what gets pinned.

## Status

| Property  | Value                                                                                 |
| --------- | ------------------------------------------------------------------------------------- |
| Kinds     | `build`                                                                               |
| Cacheable | No; resolution reaches the network and is not reproducible from declared inputs alone |
| Outputs   | The lockfile the declared manager writes                                              |

Two runs a week apart can pin different versions of the same declared range.
That is exactly what a cache must not paper over.

## See also

- [Install](./install.md)
- [PnpmWorkspace](./pnpm-workspace.md)
