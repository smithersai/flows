/**
 * Workspace package scaffolding.
 *
 * `//:newPackage` writes the smallest tree a workspace default rule can pick
 * up: a manifest, a tsconfig, one source file, one test, and a README. It
 * deliberately writes NO `BUILD.ts`. A standard package needs none — the root
 * default rule synthesizes its `lib`, `test`, `lint`, and manifest targets from
 * the directory alone — and scaffolding one would opt the new package out of
 * exactly the defaults it was created to follow.
 *
 * @since 0.1.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow-next"
import type * as Node from "@smthrs/plan-next/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { failureMessage, WriteFileError, writeGeneratedFile } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import { assertPackageName, License, merge, render } from "./PackageJson.ts"
import * as Rule from "./Rule.ts"

/**
 * Payload for one scaffold run.
 *
 * The package NAME is not here: it is a per-invocation argument, not a
 * declaration, so it arrives through the layer from `tsflows run --name`. Attrs
 * that changed per invocation would re-key the target on every run and record a
 * cache entry per name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ScaffoldPayload = Schema.Struct({
  /** The workspace-relative directory new packages are created under. */
  directory: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  license: License,
  /** Shared manifest fields, normally a `PackageJsonTemplate` template's. */
  fields: Schema.Record(Schema.String, Schema.Unknown),
  /** The tsconfig the generated package extends, relative to the new package. */
  tsconfigExtends: Schema.NonEmptyString
})

/**
 * Payload for one scaffold run.
 *
 * @category models
 * @since 0.1.0
 */
export type ScaffoldPayload = typeof ScaffoldPayload.Type

/**
 * Result of one scaffold run: the created directory and every file written.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ScaffoldReport = Schema.Struct({
  directory: Schema.NonEmptyString,
  files: Schema.Array(Schema.NonEmptyString)
})

/**
 * Result of one scaffold run.
 *
 * @category models
 * @since 0.1.0
 */
export type ScaffoldReport = typeof ScaffoldReport.Type

/**
 * Creates one package directory in the source tree.
 *
 * @category actions
 * @since 0.1.0
 */
export const ScaffoldPackage = Action.make("tsflows-rules/scaffold-package", {
  payload: ScaffoldPayload,
  success: ScaffoldReport,
  error: WriteFileError,
  tier: "sealed"
})

/** The directory name a scoped npm name maps to: `@scope/foo` becomes `foo`. */
const directoryName = (name: string): string => name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name

/**
 * The static boilerplate a scaffolded package starts from.
 *
 * A model could write a better README and a better first test, and the
 * `packageJsonRefresh` target is where a model is allowed to. Scaffolding
 * itself stays static: `tsflows run //:newPackage` must work on a machine with
 * no model CLI, offline, and produce the same tree every time.
 *
 * @category rendering
 * @since 0.1.0
 */
export const boilerplate = (
  name: string,
  payload: ScaffoldPayload
): ReadonlyArray<readonly [string, string]> => {
  const manifest = merge(payload.fields, {
    name,
    version: payload.version,
    license: payload.license,
    type: "module",
    sideEffects: [],
    exports: { "./package.json": "./package.json", ".": "./src/index.ts" },
    files: ["src/**/*.ts", "README.md"]
  })
  const identifier = directoryName(name).replace(/[^A-Za-z0-9]+(.)/g, (_, character: string) => character.toUpperCase())
  return [
    ["package.json", render(manifest)],
    [
      "tsconfig.json",
      `${
        JSON.stringify(
          { extends: payload.tsconfigExtends, include: ["src/**/*", "test/**/*"] },
          undefined,
          2
        )
      }\n`
    ],
    [
      "src/index.ts",
      `/**\n * ${name}\n *\n * @since 0.1.0\n */\n\n/**\n * The package name.\n *\n * @category constants\n * @since 0.1.0\n */\nexport const ${identifier} = ${
        JSON.stringify(name)
      }\n`
    ],
    [
      "test/index.test.ts",
      `import { describe, expect, it } from "vitest"\nimport { ${identifier} } from "../src/index.ts"\n\ndescribe(${
        JSON.stringify(name)
      }, () => {\n  it("exports its own name", () => {\n    expect(${identifier}).toBe(${
        JSON.stringify(name)
      })\n  })\n})\n`
    ],
    [
      "README.md",
      `# ${name}\n\nCreated by \`tsflows run //:newPackage --name ${name}\`.\n\nThis package has no BUILD.ts: the workspace default rule synthesizes its\ntargets from this directory.\n`
    ]
  ]
}

/**
 * Options accepted by {@link scaffold} and {@link ScaffoldPackageLive}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScaffoldOptions {
  readonly workspaceRoot: string
  /** The name supplied by `tsflows run --name`, absent when the flag was not given. */
  readonly packageName?: string | undefined
}

/**
 * Writes one new package directory.
 *
 * The name is validated with the same {@link assertPackageName} a declaration
 * uses, and an existing directory is refused rather than merged into: a
 * scaffold that overwrote files would be a destructive command spelled like a
 * creative one.
 *
 * @category execution
 * @since 0.1.0
 */
export const scaffold = (
  options: ScaffoldOptions,
  payload: ScaffoldPayload
): Effect.Effect<ScaffoldReport, WriteFileError> =>
  Effect.gen(function*() {
    const directory = Input.resolvePath("", payload.directory)
    if (options.packageName === undefined || options.packageName === "") {
      return yield* Effect.fail(
        new WriteFileError({
          path: directory,
          message: "no package name was supplied; run `tsflows run //:newPackage --name <package-name>`"
        })
      )
    }
    const name = yield* Effect.try({
      try: () => assertPackageName(options.packageName!),
      catch: (cause) => new WriteFileError({ path: directory, message: failureMessage(cause) })
    })
    const created = `${directory}/${directoryName(name)}`
    const exists = yield* Effect.tryPromise({
      try: () => Fs.stat(NodePath.resolve(options.workspaceRoot, created)).then(() => true, () => false),
      catch: (cause) => new WriteFileError({ path: created, message: failureMessage(cause) })
    })
    if (exists) {
      return yield* Effect.fail(
        new WriteFileError({ path: created, message: `${created} already exists; scaffolding never overwrites` })
      )
    }
    const files: Array<string> = []
    for (const [relative, contents] of boilerplate(name, payload)) {
      const path = `${created}/${relative}`
      yield* writeGeneratedFile(options.workspaceRoot, { path, contents })
      files.push(path)
    }
    return { directory: created, files }
  })

/**
 * Implements {@link ScaffoldPackage} against the source tree.
 *
 * @category layers
 * @since 0.1.0
 */
export const ScaffoldPackageLive = (
  options: ScaffoldOptions
): Layer.Layer<Action.Requirement<"tsflows-rules/scaffold-package">, never, FlowRuntime.FlowRuntime> =>
  ScaffoldPackage.toLayer((payload) => scaffold(options, payload))

/**
 * Attributes for {@link NewPackage}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** @default "packages" */
  directory: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("packages"))),
  /** @default "0.1.0" */
  version: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("0.1.0"))),
  license: License,
  /** @default {} */
  fields: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, unknown>>({}))
  ),
  /** @default "../../tsconfig.base.json" */
  tsconfigExtends: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("../../tsconfig.base.json"))
  )
})

/**
 * Attributes for {@link NewPackage}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Scaffolds a new workspace package.
 *
 * The target participates in the `run` verb alone and is never cacheable: it
 * exists to leave a directory behind, and a cache hit would report success for
 * a package that was never created. The package name is a per-invocation
 * argument rather than an attr, so one declaration serves every new package:
 *
 * ```sh
 * tsflows run //:newPackage --name @smthrs/widget
 * ```
 *
 * A scoped name maps to an unscoped directory, so `@smthrs/widget` creates
 * `packages/widget`. Nothing in the created tree is a `BUILD.ts`; the workspace
 * default rule takes it from there.
 *
 * @category rules
 * @since 0.1.0
 */
export const NewPackage = Rule.make("NewPackage", {
  attrs: Attrs,
  kinds: ["run"],
  success: ScaffoldReport,
  error: WriteFileError,
  cache: false,
  implementation: (
    attrs
  ): Node.Node<ScaffoldReport, WriteFileError, Action.Requirement<"tsflows-rules/scaffold-package">> =>
    ScaffoldPackage.call({
      directory: attrs.directory,
      version: attrs.version,
      license: attrs.license,
      fields: attrs.fields,
      tsconfigExtends: attrs.tsconfigExtends
    })
})
