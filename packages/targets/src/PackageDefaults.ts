/**
 * Workspace default-target declarations and target synthesis.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { minimatch } from "minimatch"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Input from "./Input.ts"
import * as PackageJson from "./PackageJson.ts"
import * as Target from "./Target.ts"
import type * as Visibility from "./Visibility.ts"

/**
 * Runtime marker for a workspace default-target declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/PackageDefaults") as never

/**
 * A macro the planner may apply to a directory without its own BUILD.ts file.
 *
 * The declared `attrs` value is passed as the macro's argument. Every target
 * in the returned record becomes a synthesized named export.
 *
 * @category models
 * @since 0.1.0
 */
export type Macro = (attrs: never) => object

/**
 * A pure declaration of targets the planner synthesizes for directories
 * without their own BUILD.ts file.
 *
 * The planner matches `directories` against workspace directories that contain
 * the `marker` file and lack the `unless` file, then applies the macro to
 * every match. A `null` marker drops the marker requirement: every directory
 * that matches the glob, directly holds at least one discovered file, and
 * lacks the `unless` file is eligible. That is the folder-unit form, which
 * synthesizes targets for a folder inside a package without asking the folder
 * for a `package.json`. Declare workspace-wide defaults in the root BUILD.ts
 * file; the planner loads it before it synthesizes anything.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageDefaults {
  readonly [TypeId]: typeof TypeId
  readonly directories: Input.Glob
  readonly marker: string | null
  readonly unless: string
  readonly macro: Macro
  readonly attrs: Readonly<Record<string, unknown>>
}

/**
 * Options accepted by {@link PackageDefaults}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly directories: string | Input.Glob
  /** Pass `null` to synthesize marker-less directories. @default "package.json" */
  readonly marker?: string | null | undefined
  /** @default "BUILD.ts" */
  readonly unless?: string | undefined
  readonly macro: Macro
  /** @default {} */
  readonly attrs?: Readonly<Record<string, unknown>> | undefined
}

const Marker = Schema.NullOr(Schema.NonEmptyString).pipe(
  Schema.withConstructorDefault(Effect.succeed<string | null>("package.json"))
)

const Unless = Schema.NonEmptyString.pipe(
  Schema.withConstructorDefault(Effect.succeed("BUILD.ts"))
)

const DefaultAttrs = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.withConstructorDefault(Effect.succeed<Record<string, unknown>>({}))
)

const Defaults = Schema.Struct({
  marker: Marker,
  unless: Unless,
  attrs: DefaultAttrs
})

/**
 * Creates a pure workspace default-target declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): PackageDefaults => {
  const defaults = Defaults.make({
    ...(options.marker === undefined ? {} : { marker: options.marker }),
    ...(options.unless === undefined ? {} : { unless: options.unless }),
    ...(options.attrs === undefined ? {} : { attrs: options.attrs })
  })
  return {
    [TypeId]: TypeId,
    directories: typeof options.directories === "string" ? Input.glob(options.directories) : options.directories,
    marker: defaults.marker,
    unless: defaults.unless,
    macro: options.macro,
    attrs: defaults.attrs
  }
}

/**
 * Declares pure workspace defaults using the BUILD.ts calling convention.
 *
 * A string `directories` value is lifted to {@link Input.glob}. Construction
 * validates the declaration and performs no I/O.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const packageDefaults = Smithers.PackageDefaults({
 *   directories: "packages/*",
 *   macro: Smithers.StandardPackage
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const PackageDefaults = (options: Options): PackageDefaults => make(options)

const missing: unique symbol = Symbol("missing default-target property")

/** Reads an own data property without invoking an accessor. */
const own = (value: object, key: PropertyKey): unknown | typeof missing => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : missing
}

/** Whether an object has only ordinary enumerable data fields. */
const isDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  return Object.getOwnPropertyNames(value).every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true
  })
}

/** Whether a value is a dense, accessor-free array of strings. */
const isStringArray = (value: unknown): value is ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value) || !Array.isArray(value)) return false
  const length = own(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return false
  for (let index = 0; index < length; index += 1) {
    if (typeof own(value, String(index)) !== "string") return false
  }
  return true
}

/**
 * Checks whether a BUILD.ts export is a default-target declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPackageDefaults = (value: unknown): value is PackageDefaults => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const directories = own(value, "directories")
  if (typeof directories !== "object" || directories === null || NodeUtil.isProxy(directories)) return false
  return own(value, TypeId) === TypeId &&
    own(directories, "_tag") === "Glob" &&
    typeof own(directories, "pattern") === "string" &&
    isStringArray(own(directories, "exclude")) &&
    (typeof own(value, "marker") === "string" || own(value, "marker") === null) &&
    typeof own(value, "unless") === "string" &&
    typeof own(value, "macro") === "function" &&
    isDataRecord(own(value, "attrs"))
}

/**
 * Checks whether one workspace directory matches a declaration's glob.
 *
 * `declaringPackage` is the package path of the BUILD.ts file that exported
 * the declaration; the glob and its excludes resolve relative to it.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const matches = (
  target: PackageDefaults,
  declaringPackage: string,
  directory: string
): boolean => {
  const pattern = Input.resolvePath(declaringPackage, target.directories.pattern)
  if (!minimatch(directory, pattern, { dot: true })) return false
  return !target.directories.exclude.some((exclude) =>
    minimatch(directory, Input.resolvePath(declaringPackage, exclude), { dot: true })
  )
}

/**
 * The filesystem seam a manifest read goes through.
 *
 * Synthesis never calls `node:fs` directly; it calls this. Production supplies
 * {@link defaultManifestIo}, and a test supplies a record of fixture manifests,
 * so a synthesis test states the manifest it means instead of writing one to a
 * temporary directory. `readText` answers undefined for anything it cannot
 * read, because a directory without a readable manifest is a directory the
 * macro expands without one.
 *
 * @category models
 * @since 0.1.0
 */
export interface ManifestIo {
  readonly readText: (path: string) => string | undefined
}

/**
 * Reads a manifest through `node:fs`.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const defaultManifestIo: ManifestIo = {
  readText: (path) => {
    try {
      return NodeFs.readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  }
}

/**
 * The manifest fields a macro receives for the directory it expands.
 *
 * It is {@link Visibility.PackageManifest} plus the `private` flag, which is
 * the second half of publishability: `scripts/pack-release.mjs` derives the
 * release set from `smthrs.group` and then drops every private manifest. Each
 * field is undefined, or false for `private`, when the directory has no
 * readable manifest or the manifest omits it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Manifest extends Visibility.PackageManifest {
  readonly private: boolean
}

/**
 * Options accepted by {@link expand}, {@link synthesize}, and
 * {@link readManifest}.
 *
 * `root` is the workspace root every directory resolves against and defaults
 * to the process working directory, which is what `--workspace` itself
 * defaults to. A caller whose workspace root is somewhere else has to pass it:
 * expansion receives a workspace-relative directory and nothing more, so it
 * cannot recover a root it was not given, and an unreadable manifest expands
 * to a macro call with no name, version, or group.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExpandOptions {
  readonly root?: string | undefined
  readonly io?: ManifestIo | undefined
}

/** Reads an own string field of a parsed manifest, or undefined. */
const text = (manifest: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined => {
  const value = manifest === undefined ? undefined : manifest[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * Reads one directory's `package.json` as the fields a macro may branch on.
 *
 * The read is total: a missing, unreadable, or malformed manifest answers the
 * same shape with undefined fields rather than failing synthesis, because a
 * declaration may name a marker other than `package.json` and a directory that
 * carries no manifest still expands.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const readManifest = (directory: string, options: ExpandOptions = {}): Manifest => {
  const io = options.io ?? defaultManifestIo
  const root = options.root ?? process.cwd()
  const source = io.readText(NodePath.join(root, directory, "package.json"))
  let parsed: unknown
  try {
    parsed = source === undefined ? undefined : JSON.parse(source)
  } catch {
    parsed = undefined
  }
  const manifest = isDataRecord(parsed) ? parsed : undefined
  const smthrs = manifest === undefined ? undefined : manifest["smthrs"]
  return {
    directory,
    name: text(manifest, "name"),
    version: text(manifest, "version"),
    smthrs: { group: text(isDataRecord(smthrs) ? smthrs : undefined, "group") },
    private: manifest !== undefined && manifest["private"] === true
  }
}

/**
 * What one macro application produced: its named targets and its named package
 * manifest declarations.
 *
 * A manifest declaration is not a target yet. Its scripts name targets whose
 * labels only the workspace index knows, so the index resolves them and expands
 * the declaration itself. Returning both from one macro application matters:
 * running the macro twice would produce two sets of distinct target objects,
 * and target object identity is what the index maps back to a label.
 *
 * @category models
 * @since 0.1.0
 */
export interface Expansion {
  readonly targets: ReadonlyArray<readonly [string, Target.AnyTarget]>
  readonly declarations: ReadonlyArray<readonly [string, PackageJson.Declaration]>
}

/**
 * Applies the declaration's macro once and sorts what it produced.
 *
 * The macro receives the declared attrs over a `cwd` default naming the
 * synthesized directory, so a macro that runs tools runs them inside the
 * package it was synthesized for; declared attrs still win. It also receives
 * the matched directory's `name`, `version`, `group`, and `private` fields,
 * read by {@link readManifest}. Declared attrs are one static record shared by
 * every match, so without the manifest a macro cannot name the package it is
 * expanding, cannot know its version, and cannot tell an engine package from
 * an agent package. Names are sorted by UTF-16 code unit so synthesized labels
 * are deterministic on every host; `localeCompare` answers differently under
 * different locales and ICU versions, which would order two machines'
 * synthesized targets differently. Every other property of the macro result is
 * ignored.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const expand = (
  target: PackageDefaults,
  directory: string,
  options: ExpandOptions = {}
): Expansion => {
  const manifest = readManifest(directory, options)
  const produced = (target.macro as (attrs: Readonly<Record<string, unknown>>) => object)({
    cwd: directory,
    name: manifest.name,
    version: manifest.version,
    group: manifest.smthrs.group,
    private: manifest.private,
    ...target.attrs
  })
  if (!isDataRecord(produced)) {
    throw new TypeError(`default target for //${directory} must return a plain record of declarations`)
  }
  const targets: Array<readonly [string, Target.AnyTarget]> = []
  const declarations: Array<readonly [string, PackageJson.Declaration]> = []
  for (
    const [name, value] of Object.entries(produced).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  ) {
    if (Target.isTarget(value)) targets.push([name, value])
    else if (PackageJson.isDeclaration(value)) declarations.push([name, value])
  }
  if (targets.length === 0 && declarations.length === 0) {
    throw new Error(`default target synthesized no targets for //${directory}`)
  }
  return { targets, declarations }
}

/**
 * Applies the declaration's macro and collects the targets it returns.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const synthesize = (
  target: PackageDefaults,
  directory: string,
  options: ExpandOptions = {}
): ReadonlyArray<readonly [string, Target.AnyTarget]> => expand(target, directory, options).targets
