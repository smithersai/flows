# JsrPublish

Publishes a package to JSR.

```ts
import { JsrPublish, file, glob } from "tsflows-rules"

export const publishJsr = JsrPublish({
  config: file("//packages/flow/jsr.json"),
  sources: [glob("//packages/flow/src/**/*.ts")],
  deps: [publish],
  package: "@smthrs/flow",
  allowDirty: false,
  dryRun: true
})
```

## Attributes

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `config` | `Input.File` | required | The JSR config. Its directory is where `jsr publish` runs. |
| `sources` | `Array<Input.Declared>` | required | Source declarations digested as key material. |
| `deps` | `Array<Rule.Target>` | required | Dependency targets, usually the npm publish target. |
| `package` | `string` | required | The published identity. Key material only; jsr reads the name from the config file. |
| `allowDirty` | `boolean` | required | Append `--allow-dirty`. |
| `dryRun` | `boolean` | `true` | Append `--dry-run`. A real publish is always an explicit opt-out. |

There is no `cwd`. The publish directory is the directory of `config.path`, with
a leading `//` stripped.

## Command

Through the irreversible exec action, because publication changes external
registry state:

```
pnpm dlx jsr publish [--allow-dirty] [--dry-run]
```

## Inputs

Collected from the attrs: `config`, plus every declaration in `sources`.

## Channels

| Channel | Type |
| --- | --- |
| Success | `Exec.Result` |
| Error | `Exec.ExecError` |

## Status

| | |
| --- | --- |
| Kinds | `run` |
| Cacheable | Never |
| Executes | **No.** The CLI executor does not provide `ExecIrreversibleLive`, so the `tsflows-rules/exec-irreversible` action has no implementation in scope and the target fails at interpretation with `unresolved_action`. |

The rule plans only under the `run` kind, so `build`, `test`, and `lint` never
select it as a root.

## See also

- [NpmPublish](npm-publish.md), which runs before JSR publication
- [Changesets](changesets.md), which declares the irreversible exec action
