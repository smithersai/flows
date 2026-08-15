# Clean

Deletes explicitly declared generated paths.

```ts
import { Clean } from "tsflows-rules"

export const clean = Clean({
  paths: ["dist", "coverage", "*.tsbuildinfo"],
  deps: [],
  includeNodeModules: false,
  cwd: "packages/flow"
})
```

## Attributes

| Name                 | Type                 | Default  | Description                                                               |
| -------------------- | -------------------- | -------- | ------------------------------------------------------------------------- |
| `paths`              | `Array<string>`      | required | Paths to remove, resolved from `cwd`. Every entry must stay inside `cwd`. |
| `deps`               | `Array<Rule.Target>` | required | Dependency targets.                                                       |
| `includeNodeModules` | `boolean`            | required | Also remove `node_modules` in `cwd`.                                      |
| `cwd`                | `string`             | `"."`    | Workspace-relative directory the paths resolve from.                      |

## Command

One exec node running a static Node script that removes exactly the paths it
receives as arguments:

```
node -e "const fs = require('node:fs'); for (const target of process.argv.slice(1)) fs.rmSync(target, { recursive: true, force: true });" <paths...>
```

The script is a constant. Nothing about it varies with attrs except the argument
list.

## Path validation

Each path is normalized and checked at plan time. These are refused with
`Clean only removes paths inside its directory: <path>`:

- An absolute path.
- `.`, which would delete the directory itself.
- `..`, or anything normalizing to a `../` prefix.

The check happens during `BUILD.ts` evaluation, so an invalid path fails every
command, not just execution.

## Inputs

None. The rule declares no input attributes.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Key material

`capabilities` for this rule is `["fs:delete"]`, not the default
`["fs:read", "proc:spawn"]`.

## Status

|           |                                                                |
| --------- | -------------------------------------------------------------- |
| Kinds     | `run`                                                          |
| Cacheable | Never; deletion changes local state and has no reusable result |
| Executes  | Yes, through `ExecLive`, as a `run` root or dependency         |

Invoke it explicitly with `tsflows run <label>`. Making a build depend on clean
is rarely useful: deleting outputs before a build defeats cache reuse.

## See also

- [Running targets](../../workspace/running-targets.md)
- [Dev](dev.md)
