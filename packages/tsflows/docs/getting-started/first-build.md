# First build

This tutorial writes a root `BUILD.ts` and one package `BUILD.ts`, then runs each
CLI verb against them. It assumes the layout from [Install](install.md).

## 1. Declare the root

The root `BUILD.ts` holds workspace-wide declarations: configuration, shared
input values, the install target, and any default rules.

```ts
// BUILD.ts
import { file, PnpmWorkspace, Workspace } from "tsflows-rules"

export const config = Workspace({ cacheDirectory: ".flows", gitignored: true })

export const nodeModules = PnpmWorkspace({
  packageManager: "pnpm@11.21.0"
})

export const rootJSDocConfig = file("//eslint.jsdoc.js")
```

`config` and `rootJSDocConfig` are not targets. `nodeModules` is: it becomes
`//:nodeModules`, and `//` resolves to it because the default-target search tries
`lib`, then `nodeModules`, then the package basename, then `default`.

## 2. Declare a package

Point `StandardPackage` at a package directory. It expands into three targets.

```ts
// packages/greeter/BUILD.ts
import { StandardPackage } from "tsflows-rules"

export const { lib, test, lint } = StandardPackage({
  deps: [],
  cwd: "packages/greeter"
})
```

`cwd` is the workspace-relative directory every emitted tool runs in. The macro's
defaults follow the flows layout: sources at `src/**/*.ts`, tests at
`test/**/*.test.ts`, `tsc -p tsconfig.json`, Vitest with the package
`vitest.config.ts`, and ESLint with the package `eslint.config.js` plus the root
`eslint.jsdoc.js`.

The three labels are `//packages/greeter:lib`, `//packages/greeter:test`, and
`//packages/greeter:lint`.

## 3. Add an edge

Import another package's target to declare a dependency.

```ts
// packages/app/BUILD.ts
import { StandardPackage } from "tsflows-rules"
import { lib as greeter } from "../greeter/BUILD.ts"

export const { lib, test, lint } = StandardPackage({
  deps: [greeter],
  cwd: "packages/app"
})
```

`//packages/app:lib` now depends on `//packages/greeter:lib`. No label string
appears anywhere. See [Dependencies](../concepts/dependencies.md).

## 4. List targets

```sh
tsflows query //...
```

The result lists each discovered target with its rule and the verbs it
participates in:

```
query: //...
targets:
  - label: //:nodeModules
    rule: PnpmWorkspace
    kinds: [run]
  - label: //packages/app:lib
    rule: TsBuild
    kinds: [build]
  ...
```

Output is [TOON](https://github.com/toon-format/toon) by default. Add `--json`
for JSON.

## 5. Inspect the graph

```sh
tsflows graph //packages/app:lib
```

```
//packages/app:lib (TsBuild)
└─ //packages/greeter:lib (TsBuild)
```

`--mermaid` renders the same graph as a Mermaid `flowchart LR`.

## 6. Print a plan without running it

```sh
tsflows build //... --plan
```

The plan lists targets in dependency-first order with the expanded declared
inputs, the four key-material fields, and the sha256 content key. Nothing runs.

## 7. Execute

```sh
tsflows build //...
tsflows test //packages/greeter:test
tsflows lint //packages/...
```

Each verb selects the targets whose rule declares that kind, plans their
transitive dependency closure, and executes it in dependency order with bounded
parallelism. One status line per target goes to standard error:

```
//packages/greeter:lib  ran  1.4s
//packages/app:lib  ran  0.9s
2 targets: 0 hit, 2 ran, 0 failed, 0 skipped (2.3s)
```

Run it again and the cacheable targets report `hit`.

`ci` merges the build, test, and lint plans over one pattern and executes the
merged graph once:

```sh
tsflows ci //...
```

## 8. Install dependencies

```sh
tsflows install --workspace .
```

This runs the `Install` flow under the pnpm layer: measure, fetch into
`.flows/store/pnpm`, then link `node_modules`. See
[Install](../concepts/install.md).

## Next

- [Writing BUILD files](../workspace/writing-build-files.md)
- [Running targets](../workspace/running-targets.md)
- [CLI reference](../reference/cli.md)
