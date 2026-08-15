# StandardPackage

Expands one conventional TypeScript package into `lib`, `test`, and `lint`.

`StandardPackage` is a **macro**, not a rule. It has no id, no attrs schema, no
node in the graph, and no label. It calls [TsBuild](ts-build.md),
[Vitest](vitest.md), and [EsLint](es-lint.md) and returns their targets.

```ts
// packages/plan/BUILD.ts
import { StandardPackage } from "tsflows-rules"

export const { lib, test, lint } = StandardPackage({ deps: [], cwd: "packages/plan" })
```

## Options

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `deps` | `Array<Rule.AnyTarget>` | required | Dependency targets threaded into `lib` and `test`. |
| `cwd` | `string` | `"."` | Workspace-relative package directory every emitted tool runs in. |
| `sources` | `Input.Glob` | `glob("src/**/*.ts")` | The source set. |
| `tests` | `Input.Glob` | `glob("test/**/*.test.ts")` | The test set. |
| `tsconfig` | `Input.File` | `file("tsconfig.json")` | The tsconfig `tsc -p` builds. |
| `vitestConfig` | `Input.File \| null` | `file("vitest.config.ts")` | The Vitest config. Pass `null` explicitly to run Vitest with no `--config`. |
| `eslintConfigs` | `Array<Input.File>` | `[file("eslint.config.js"), file("//eslint.jsdoc.js")]` | The flat configs. |

`vitestConfig` distinguishes `undefined`, which means "use the default", from
`null`, which means "pass no `--config`".

## What it emits

```ts
interface StandardTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly test: ReturnType<typeof Vitest>
  readonly lint: ReturnType<typeof EsLint>
}
```

| Target | Rule | Attributes |
| --- | --- | --- |
| `lib` | `TsBuild` | `srcs: [sources]`, `entries: ["src/index.ts"]`, `deps`, `tsconfig`, `tool: "tsc"`, `format: "dual"`, `outDir: "dist"`, `external: []`, `cwd` |
| `test` | `Vitest` | `tests: [tests]`, `sources: [sources]`, `deps: [lib, ...deps]`, `config: vitestConfig`, `environment: "node"`, `passWithNoTests: false`, `cwd` |
| `lint` | `EsLint` | `sources: [sources]`, `deps: []`, `configs: eslintConfigs`, `maxWarnings: 0`, `fix: false`, `cwd` |

Notes on the edges and the lint scope:

- `test` depends on `lib` plus the caller's `deps`, because a test run needs its
  own package built and its dependencies too.
- `lint` depends on nothing: linting one package's sources does not require
  another package to be built.
- `lint` covers the source glob only. The flat config declares no coverage for
  test files, and ESLint 9 fails on a pattern whose matches are all
  unconfigured. A package whose config does cover tests should call `EsLint`
  directly with both globs.

## As a default-rule macro

Every option has a convention default, and synthesis supplies `cwd`, so it
plugs straight into a `DefaultRule` declaration:

```ts
// BUILD.ts
export const packageDefaults = DefaultRule({
  directories: "packages/*",
  macro: StandardPackage
})
```

See [Default rules](../../extending/default-rules.md).

## Status

Not a rule, so it has no kinds, no cacheability, and no execution status of its
own. The three targets it emits each carry their own; all three execute today.

## Open question

`API-REVIEW.md` records as open question 4 whether the macro should also expose
typechecking, declaration builds, and formatting as separate targets, or keep the
review surface at exactly `lib`, `test`, and `lint`.

## See also

- [Writing macros](../../extending/writing-macros.md)
- [TsBuild](ts-build.md), [Vitest](vitest.md), [EsLint](es-lint.md)
