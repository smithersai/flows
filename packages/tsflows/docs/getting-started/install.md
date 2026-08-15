# Install

tsflows lives in the flows repository as three pnpm workspace packages:

```
flows/
  BUILD.ts
  packages/
    tsflows/        # @smthrs/tsflows-next — Install and PackageManager
    tsflows-rules/  # tsflows-rules — the BUILD.ts authoring surface
    tsflows-cli/    # tsflows-cli — the tsflows bin
```

`@smthrs/tsflows-next` is the publishable library. `tsflows-rules` and
`tsflows-cli` are private and never published.

## Requirements

- Node.js 22.19 or newer.
- pnpm. Every catalog rule resolves its tool through `pnpm exec`, and the CLI's
  install verb uses the pnpm package-manager layer.
- A git worktree. Discovery prefers `git ls-files`; outside a worktree it falls
  back to a `.gitignore` walker.

## Link the authoring package

The flows root manifest declares both the authoring package and CLI as
devDependencies at the workspace version:

```json
// flows/package.json
{
  "devDependencies": {
    "tsflows-cli": "0.1.0",
    "tsflows-rules": "0.1.0"
  }
}
```

`linkWorkspacePackages` resolves the exact version to the workspace package, so
`pnpm install` links both packages with no `file:` or `link:` specifier. The CLI
dependency exposes the `tsflows` bin to `pnpm exec` at the workspace root.

`BUILD.ts` files then import by bare specifier:

```ts
// flows/BUILD.ts
import { file, glob, PnpmWorkspace, StandardPackage } from "tsflows-rules"
```

## Install the CLI dependencies

The CLI package depends on the flows engine packages, on
`@smthrs/tsflows-next`, and on `tsflows-rules` at the workspace version:

```json
// packages/tsflows-cli/package.json
{
  "dependencies": {
    "@smthrs/engine-next": "0.1.0",
    "@smthrs/flow-next": "0.1.0",
    "@smthrs/plan-next": "0.1.0",
    "@smthrs/tsflows-next": "0.1.0",
    "tsflows-rules": "0.1.0",
    "incur": "0.5.1",
    "tsx": "4.23.12"
  }
}
```

The root `pnpm install` installs and links them like every other workspace
package.

## Run the CLI

The bin entry is `tsflows`, backed by `packages/tsflows-cli/src/main.js`. That
file is a JavaScript bootstrap: it loads `main.ts` through the programmatic
`tsx` loader, which is also what evaluates `BUILD.ts` modules.

```sh
# From the workspace root.
pnpm exec tsflows query //...
```

Or point the CLI at the workspace explicitly from anywhere:

```sh
tsflows query //... --workspace /path/to/flows
```

`--workspace` defaults to the process working directory. The current directory
also determines which package a relative `:target` label resolves in. See
[Labels](../concepts/labels.md).

## Ignore the cache directory

tsflows keeps its result cache and rule scratch files under a
workspace-relative directory, `.flows` by default. Add it to the workspace
`.gitignore`, or declare the policy in the root `BUILD.ts` and let the CLI
maintain the entry:

```ts
// flows/BUILD.ts
import { Workspace } from "tsflows-rules"

export const config = Workspace({ cacheDirectory: ".flows", gitignored: true })
```

See [Configuration](../workspace/configuration.md).

The ordinary target verbs may use another configured directory. The dedicated
`tsflows install` verb currently requires `.flows`, because its declared pnpm
store boundary is fixed at `.flows/store/pnpm`.

## Next

- [First build](first-build.md)
- [Workspace structure](../workspace/structure.md)
