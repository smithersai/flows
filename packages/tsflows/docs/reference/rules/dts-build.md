# DtsBuild

Emits TypeScript declarations with `tsc --emitDeclarationOnly` or
`tsup --dts-only`.

```ts
import { DtsBuild, file, glob } from "tsflows-rules"

export const types = DtsBuild({
  srcs: [glob("src/**/*.ts")],
  entries: ["src/index.ts"],
  deps: [],
  tsconfig: file("tsconfig.build.json"),
  tool: "tsc",
  outDir: "dist",
  declarationMap: true,
  cwd: "packages/flow"
})
```

## Attributes

| Name             | Type                    | Default  | Description                                                             |
| ---------------- | ----------------------- | -------- | ----------------------------------------------------------------------- |
| `srcs`           | `Array<Input.Declared>` | required | Source declarations. Digested as key material.                          |
| `entries`        | `Array<string>`         | required | Entry points. Passed to `tsup`; key material only for `tsc`.            |
| `deps`           | `Array<Rule.Target>`    | required | Dependency targets.                                                     |
| `tsconfig`       | `Input.File`            | required | The tsconfig the emit uses.                                             |
| `tool`           | `"tsup" \| "tsc"`       | required | Which emitter to run.                                                   |
| `outDir`         | `string`                | required | Captured output directory, relative to `cwd`.                           |
| `declarationMap` | `boolean`               | required | Emit `.d.ts.map` files. Forced explicitly for `tsc`; ignored by `tsup`. |
| `cwd`            | `string`                | `"."`    | Workspace-relative directory the tool runs in.                          |

## Command

For `tsc`, `declarationMap` is forced on the command line so the emitted tree
matches the declared policy whatever the tsconfig says. The tsconfig still owns
the destination, and `outDir` remains the declared capture path:

```
pnpm exec tsc -p <tsconfig.path> --declaration --emitDeclarationOnly --declarationMap <true|false>
```

For `tsup`:

```
pnpm exec tsup <entries...> --dts-only --out-dir <outDir>
```

tsup emits no declaration maps, so `--dts-only` ignores `declarationMap`.

## Inputs

Collected from the attrs: every declaration in `srcs`, plus `tsconfig`.

## Outputs

Success is `Outputs`, the same shape [TsBuild](ts-build.md#outputs) produces. The
plan ends with the shared output-capture step over `outDir`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Outputs`        |
| Error   | `Exec.ExecError` |

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `build`                 |
| Cacheable | Always                  |
| Executes  | Yes, through `ExecLive` |

## See also

- [TsBuild](ts-build.md) for the JavaScript distribution
- [Typecheck](typecheck.md) for checking without emit
