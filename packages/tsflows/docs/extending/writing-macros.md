# Writing macros

A macro is an ordinary function that calls rules and returns targets. It is not a
rule: it has no id, no attrs schema, no node in the graph, and no label. The
targets it returns are the only things that exist afterwards.

## The worked example

`StandardPackage` expands one conventional TypeScript package into three targets.

```ts
// packages/tsflows-rules/src/StandardPackage.ts
export interface Options {
  readonly deps: ReadonlyArray<Rule.AnyTarget>
  readonly cwd?: string | undefined
  readonly sources?: Input.Glob | undefined
  readonly tests?: Input.Glob | undefined
  readonly tsconfig?: Input.File | undefined
  readonly vitestConfig?: Input.File | null | undefined
  readonly eslintConfigs?: ReadonlyArray<Input.File> | undefined
}

export interface StandardTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly test: ReturnType<typeof Vitest>
  readonly lint: ReturnType<typeof EsLint>
}

export const StandardPackage = (options: Options): StandardTargets => {
  const cwd = options.cwd ?? "."
  const sources = options.sources ?? Input.glob("src/**/*.ts")
  const tests = options.tests ?? Input.glob("test/**/*.test.ts")
  const tsconfig = options.tsconfig ?? Input.file("tsconfig.json")
  const vitestConfig = options.vitestConfig === undefined
    ? Input.file("vitest.config.ts")
    : options.vitestConfig
  const eslintConfigs = options.eslintConfigs ?? [
    Input.file("eslint.config.js"),
    Input.file("//eslint.jsdoc.js")
  ]

  const lib = TsBuild({
    srcs: [sources],
    entries: ["src/index.ts"],
    deps: options.deps,
    tsconfig,
    tool: "tsc",
    format: "dual",
    outDir: "dist",
    external: [],
    cwd
  })

  const test = Vitest({
    tests: [tests],
    sources: [sources],
    deps: [lib, ...options.deps],
    config: vitestConfig,
    environment: "node",
    passWithNoTests: false,
    cwd
  })

  const lint = EsLint({
    sources: [sources],
    deps: [],
    configs: eslintConfigs,
    maxWarnings: 0,
    fix: false,
    cwd
  })

  return { lib, test, lint }
}
```

Use it by destructuring:

```ts
// packages/plan/BUILD.ts
import { StandardPackage } from "tsflows-rules"

export const { lib, test, lint } = StandardPackage({ deps: [], cwd: "packages/plan" })
```

## What the example demonstrates

**Defaults are a policy, not a mechanism.** Every default in `StandardPackage`
encodes the flows repository layout. A caller who overrides `sources` gets a
different declared input; nothing else changes.

**Edges are threaded, not inferred.** `lib` gets the caller's `deps` directly.
`test` gets `[lib, ...deps]`, because a test run needs its own package built and
its dependencies too. `lint` gets `[]`, because linting one package's sources
does not require another package to be built.

**A declared value is shared, not duplicated.** `sources` is one `Input.Glob`
value used by both `lib` and `test`. Each target digests it independently and
gets the same digest for the same content.

**Nullability is meaningful.** `vitestConfig` distinguishes `undefined`, which
means "use the default `vitest.config.ts`", from `null`, which means "pass no
`--config`". The `undefined` check has to be explicit; `??` would collapse the
two.

**Lint covers sources only.** The flat config declares no coverage for test
files, and ESLint 9 fails on a pattern whose matches are all unconfigured. The
macro encodes that constraint so callers do not rediscover it.

## Composing a macro with rule calls

The macro's result is an ordinary object. Rename, drop, or extend it.

```ts
// packages/engine/BUILD.ts
import { DepsLint, file, glob, StandardPackage } from "tsflows-rules"
import { lib as flow } from "../flow/BUILD.ts"

const standard = StandardPackage({ deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint

export const dependencyPolicy = DepsLint({
  packageJson: file("package.json"),
  sources: [glob("src/**/*.ts"), glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: [],
  cwd: "packages/engine"
})
```

Only exported targets get labels. Export every macro target that another exported
target depends on. Planning labels every dependency it walks, so a dependency
that no `BUILD.ts` exports fails the command with
`could not derive a label for <rule>; export it from a BUILD.ts file`. In the
example above, dropping the `export` on `lib` would fail every command that
reaches `dependencyPolicy`.

## Writing your own macro

Put it in a shared module and import it from `BUILD.ts` files, or define it
directly in the root `BUILD.ts` and import it from package files.

```ts
// build/macros.ts
import { EsLint, file, glob, type Rule, TsBuild } from "tsflows-rules"

export interface BrowserPackageOptions {
  readonly deps: ReadonlyArray<Rule.AnyTarget>
  readonly cwd: string
}

export const BrowserPackage = (options: BrowserPackageOptions) => {
  const sources = glob("src/**/*.ts")

  const lib = TsBuild({
    srcs: [sources],
    entries: ["src/index.ts"],
    deps: options.deps,
    tsconfig: file("tsconfig.json"),
    tool: "tsup",
    format: "esm",
    outDir: "dist",
    external: ["react"],
    cwd: options.cwd
  })

  const lint = EsLint({
    sources: [sources],
    deps: [],
    configs: [file("eslint.config.js")],
    maxWarnings: 0,
    fix: false,
    cwd: options.cwd
  })

  return { lib, lint }
}
```

Guidelines:

- Take `cwd` and thread it into every rule call. A macro that hardcodes the
  workspace root cannot be reused by a package.
- Accept `deps` and thread them explicitly. Nothing infers edges.
- Give every option a default and let callers override one thing without
  replacing the macro.
- Return an object whose keys are the intended export names, so callers can
  destructure.
- Do not read the filesystem. A macro runs during `BUILD.ts` evaluation.

## Macros as default rules

A macro whose only required option is `cwd` can be used directly as a
default-rule macro, which is how `StandardPackage` covers every package in the
flows workspace that has no `BUILD.ts` of its own:

```ts
export const packageDefaults = DefaultRule({
  directories: "packages/*",
  macro: StandardPackage
})
```

Synthesis calls the macro with `{ cwd: <directory>, ...attrs }`. See
[Default rules](default-rules.md).

## Next

- [Default rules](default-rules.md)
- [Writing rules](writing-rules.md)
- [StandardPackage reference](../reference/rules/standard-package.md)
