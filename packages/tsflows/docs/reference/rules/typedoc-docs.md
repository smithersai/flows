# TypedocDocs

Generates API documentation with TypeDoc.

```ts
import { file, glob, TypedocDocs } from "tsflows-rules"

export const docs = TypedocDocs({
  sources: [glob("packages/*/src/**/*.ts")],
  deps: [],
  tsconfig: file("//tsconfig.json"),
  config: file("//typedoc.json"),
  entryPoints: ["//packages/flow/src/index.ts"],
  outDir: "//docs/api",
  plugin: ["typedoc-plugin-markdown"]
})
```

## Attributes

| Name          | Type                    | Default  | Description                                              |
| ------------- | ----------------------- | -------- | -------------------------------------------------------- |
| `sources`     | `Array<Input.Declared>` | required | Source declarations digested as key material.            |
| `deps`        | `Array<Rule.Target>`    | required | Dependency targets.                                      |
| `tsconfig`    | `Input.File`            | required | The tsconfig TypeDoc reads, passed as `--tsconfig`.      |
| `config`      | `Input.File \| null`    | required | A TypeDoc options file passed as `--options`, or `null`. |
| `entryPoints` | `Array<string>`         | required | Entry point paths passed as positional arguments.        |
| `outDir`      | `string`                | required | Output directory passed as `--out`.                      |
| `plugin`      | `Array<string>`         | required | Plugin package names, each passed as `--plugin`.         |

There is no `cwd` attribute. The run always happens at the workspace root.

## Command

```
pnpm exec typedoc --out <outDir> --tsconfig <tsconfig.path> \
  [--options <config.path>] [--plugin <name>]... <entryPoints...>
```

Because the run happens at the workspace root, a leading `//` is stripped from
`outDir`, `tsconfig.path`, `config.path`, and every entry point before it reaches
argv. Write workspace-rooted paths and they resolve correctly.

## Inputs

Collected from the attrs: every declaration in `sources`, plus `tsconfig`, plus
`config` when it is not `null`.

## Outputs

None captured. The rule declares no output paths, so success carries only the run
summary. `outDir` is key material and a command-line argument.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `build`                 |
| Cacheable | Always                  |
| Executes  | Yes, through `ExecLive` |

## See also

- [TsBuild](ts-build.md)
- [ToolBuild](tool-build.md)
