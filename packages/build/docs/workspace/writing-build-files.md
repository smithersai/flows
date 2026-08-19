# Writing BUILD files

A `BUILD.ts` file is a TypeScript module. The CLI imports it through the
programmatic `tsx` loader with `tsconfig: false`, then inspects every named
export.

One constraint comes from that loader. `tsconfig: false` means no tsconfig is
read, so compiler options declared in the workspace do not apply: a `paths` alias
does not resolve, and a relative import names the real file, extension included,
as in `import { lib } from "../plan/BUILD.ts"`.

## Targets are named exports

Any export whose value is a target becomes a label. The label is the package path
plus the export name.

```ts
// packages/flow/BUILD.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

export const lib = Smithers.TsBuild({
  packageManager,
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "tsc" },
  format: "dual",
  outDir: "dist",
  cwd: "packages/flow"
})

export const test = Smithers.Vitest({
  packageManager,
  tests: [tests],
  sources: [sources],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/flow"
})

export const lint = Smithers.EsLint({
  packageManager,
  sources: [sources, tests],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/flow"
})
```

`sources` and `tests` are module-local bindings, not exports, so they never
become labels. They are still declared inputs of the targets that reference them.

Exports that are not targets are ignored, with two exceptions: a `Workspace` value
configures the workspace, and a `PackageDefaults` value declares synthesis. See
[Configuration](configuration.md) and
[Default targets](../extending/default-targets.md).

## Target calls

A target call takes exactly one object: the target's attributes. The attrs are an
Effect `Schema.Struct`, so the call validates them and applies constructor
defaults. Passing an unknown key or the wrong type is a type error and a runtime
decode failure.

Every attribute value is key material. A `cwd` change, a flag flip, or a
different tool re-keys the target.

The target call itself performs no I/O. It builds a flow, walks the decoded attrs
for declared inputs and target references, and attaches planner metadata.

## Imports are dependency edges

Import a target and put it in an attrs value. The target collector walks the whole
attrs object, at any depth, through arrays and plain objects.

```ts
// packages/engine/BUILD.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"
import { lib as flow } from "../flow/BUILD.ts"

const standard = Smithers.StandardPackage({ packageManager, deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint
```

Every catalog target has a `deps` attribute typed as `Schema.Array(Target.Target)`,
which is the conventional place to put edges. Nothing requires it: a target
value in any attribute becomes an edge.

Labels never appear in attrs. See [Dependencies](../concepts/dependencies.md).

## Declared inputs

`glob()`, `file()`, and `gitDiff()` create inert values. They read nothing at
module-evaluation time. The planner expands and digests them during discovery.

```ts
const sources = glob("src/**/*.ts")
const generated = glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] })
const config = file("vitest.config.ts") // package-relative
const rootConfig = file("//eslint.jsdoc.js") // workspace-relative
const changes = gitDiff("origin/main")
```

Reuse one declared value across several targets. Each target digests it
independently, and equal content always produces an equal digest. See
[Inputs](../concepts/inputs.md).

## Macros

A macro is an ordinary function that returns targets. It is not a target, has no
identity in the graph, and produces no node of its own.

```ts
// packages/plan/BUILD.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { lib, test, lint } = Smithers.StandardPackage({ packageManager, deps: [], cwd: "packages/plan" })
```

Destructuring the result exports each target under its own name. Rename freely:

```ts
const standard = StandardPackage({ packageManager, deps: [], cwd: "packages/plan" })

export const build = standard.lib
export const check = standard.test
```

Mix a macro with extra target calls in the same file:

```ts
import { packageManager, runtime } from "../../BUILD.ts"

const standard = StandardPackage({ packageManager, deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint

export const dependencyPolicy = DepsLint({
  runtime,
  packageManager,
  packageJson: file("package.json"),
  sources: [glob("src/**/*.ts"), glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: [],
  cwd: "packages/engine"
})
```

See [Writing macros](../extending/writing-macros.md).

## The root BUILD.ts

The root file carries workspace-level declarations.

```ts
// BUILD.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })

export const runtime = Runtime.Node({ version: ">=22.19.0" })
export const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })

export const nodeModules = Smithers.Install({ packageManager })

export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage,
  attrs: { packageManager }
})
```

A shared `file()` export like `rootJSDocConfig` is a plain declared value. Other
`BUILD.ts` files import it and put it in their attrs.

## Targets to follow

- Do not read the filesystem, spawn a process, or await anything at module scope.
  Discovery imports these modules, and the model assumes evaluation is pure.
- Do not export the same target value under two names. Discovery refuses it.
- Give every tool-running target a `cwd` when it belongs to a package. The
  default is the workspace root.
- Keep `BUILD.ts` imports to `@smthrs/targets`, other `BUILD.ts` files, and
  standard TypeScript. Anything else runs at discovery time on every command.

## Next

- [Running targets](running-targets.md)
- [Targets and targets](../concepts/targets.md)
- [Target catalog](../reference/targets/README.md)
