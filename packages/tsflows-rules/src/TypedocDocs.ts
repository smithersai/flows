/**
 * TypeDoc documentation generation.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Rule from "./Rule.ts"

/**
 * Attributes for {@link TypedocDocs}.
 *
 * `sources`, `tsconfig`, `config`, and `entryPoints` are declared inputs.
 * `outDir` stays a string because it declares an output path rather than
 * referencing a file the rule reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Rule.Target),
  tsconfig: Input.File,
  config: Schema.NullOr(Input.File),
  entryPoints: Schema.Array(Input.File),
  outDir: Schema.NonEmptyString,
  plugin: Schema.Array(Schema.NonEmptyString)
})

/**
 * Attributes for {@link TypedocDocs}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** Strips the workspace-root marker so a rooted path works from the root cwd. */
const workspacePath = (path: string): string => path.startsWith("//") ? path.slice(2) : path

/**
 * Plans TypeDoc generation into the declared documentation directory.
 *
 * The body plans one `pnpm exec typedoc` run at the workspace root through
 * the shared sealed exec action: the declared tsconfig, the optional TypeDoc
 * options file, every plugin, and the entry points land on argv, and `--out`
 * points at `outDir`. Key material contains source, tsconfig, and TypeDoc
 * config digests, dependency keys, entry points, plugins, and output path.
 * The target remains non-cacheable until generated-output restoration and
 * complete external toolchain identity are wired. This models tevm's
 * `generate:docs` target and follows TypeDoc prior art. Executing the plan
 * requires {@link Exec.ExecLive}.
 *
 * @category rules
 * @since 0.1.0
 */
export const TypedocDocs = Rule.make("TypedocDocs", {
  attrs: Attrs,
  kinds: ["build"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => {
    const argv: Array<string> = [
      "pnpm",
      "exec",
      "typedoc",
      "--out",
      workspacePath(attrs.outDir),
      "--tsconfig",
      workspacePath(attrs.tsconfig.path)
    ]
    if (attrs.config !== null) argv.push("--options", workspacePath(attrs.config.path))
    for (const plugin of attrs.plugin) argv.push("--plugin", plugin)
    for (const entry of attrs.entryPoints) argv.push(workspacePath(entry.path))
    return Rule.runTool({ cwd: ".", argv })
  }
})
