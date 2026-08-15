# Changesets

Reports Changesets status, or applies versioning.

```ts
import { Changesets, file, glob } from "tsflows-rules"

export const releaseStatus = Changesets({
  operation: "status",
  changesets: [glob(".changeset/*.md")],
  config: file("//.changeset/config.json"),
  rootPackageJson: file("//package.json"),
  lockfile: file("//pnpm-lock.yaml"),
  deps: [],
  since: "origin/main"
})
```

## Attributes

| Name              | Type                    | Default  | Description                                                              |
| ----------------- | ----------------------- | -------- | ------------------------------------------------------------------------ |
| `operation`       | `"status" \| "version"` | required | Report, or apply versioning.                                             |
| `changesets`      | `Array<Input.Declared>` | required | The changeset files, digested as key material.                           |
| `config`          | `Input.File`            | required | The Changesets config.                                                   |
| `rootPackageJson` | `Input.File`            | required | The root manifest.                                                       |
| `lockfile`        | `Input.File`            | required | The lockfile.                                                            |
| `deps`            | `Array<Rule.Target>`    | required | Dependency targets.                                                      |
| `since`           | `string \| null`        | required | A base revision for `status`, passed as `--since`. Ignored by `version`. |

There is no `cwd`. Both operations run at the workspace root.

## Commands

`status` runs through the shared sealed exec action:

```
pnpm exec changeset status [--since <since>]
```

`version` runs through the irreversible exec action, because it mutates manifests
and changelogs:

```
pnpm exec changeset version
```

The irreversible tier means the engine refuses to retry it blindly, and no
verification, replay, or cache-population path may execute it.

## Inputs

Collected from the attrs: every declaration in `changesets`, plus `config`,
`rootPackageJson`, and `lockfile`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kinds     | `run`                                                                                                                                                                                          |
| Cacheable | When `operation` is `status`                                                                                                                                                                   |
| Executes  | `status` yes, through `ExecLive`, as a dependency. `version` **no**: the CLI executor does not provide `ExecIrreversibleLive`, so the target fails at interpretation with `unresolved_action`. |

Both operations plan only under the `run` kind, so `build`, `test`, and `lint`
never select them as roots.

## Release order

The intended order is status, version, build and package lint, npm publish, then
JSR publish.

## Shared exports

This module also declares the `ExecIrreversible` action and its
`ExecIrreversibleLive` layer. Both [NpmPublish](npm-publish.md) and
[JsrPublish](jsr-publish.md) use them. The action carries the same payload,
result, and error as the sealed exec action, declared at the `irreversible` tier.

## See also

- [NpmPublish](npm-publish.md)
- [JsrPublish](jsr-publish.md)
- [Actions and boundaries](../../concepts/actions-and-boundaries.md)
