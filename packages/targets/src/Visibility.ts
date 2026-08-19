/**
 * Visibility declarations for BUILD.ts targets.
 *
 * A visibility declaration names who may depend on a target. Constructors in
 * this module only create values, so BUILD.ts evaluation stays pure: nothing
 * here reads the filesystem, resolves a label, or consults a manifest.
 *
 * A declaration is a frozen plain object with string keys and a `_tag`
 * discriminator, the same shape {@link Input.Declared} uses. `Target.make` and
 * the planner both walk plain objects, both bail out of a non-plain prototype,
 * and both refuse a Proxy, so a declaration stays traversable by the code that
 * already walks declarations.
 *
 * Visibility is not key material. It reaches the planner through
 * `Target.Metadata`, beside `verbGate`, and never through the attrs struct:
 * changing who may depend on a target must not invalidate that target's cache.
 *
 * Enforcement is not implemented. Nothing reads these declarations yet. The
 * import walker that resolves a source file's imports to a target label, and
 * the manifest query {@link group} needs, are both unbuilt.
 *
 * @since 0.1.0
 */
import * as NodeUtil from "node:util/types"

/**
 * The `smthrs` manifest section a {@link group} predicate may read.
 *
 * @category models
 * @since 0.1.0
 */
export interface SmthrsSection {
  readonly group: string | undefined
}

/**
 * The package manifest fields a {@link group} predicate may read.
 *
 * `directory` is the workspace-relative package directory. The other fields
 * come from that directory's `package.json`, and each is undefined when the
 * manifest omits it.
 *
 * No manifest query exists yet. Nothing in the build system reads a
 * `package.json`: the only readers of `smthrs.group` in the tree are
 * `scripts/pack-release.mjs`, `scripts/check-test-pins.mjs`, and
 * `packages/flows/test/index.test.ts`. This interface fixes the predicate's
 * input so the enforcement lane builds one query and shares it with the
 * publish set derivation that needs the same fields.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageManifest {
  readonly directory: string
  readonly name: string | undefined
  readonly version: string | undefined
  readonly smthrs: SmthrsSection
}

/**
 * Visible to the declaring directory only.
 *
 * @category models
 * @since 0.1.0
 */
export interface Private {
  readonly _tag: "Private"
}

/**
 * Visible to every directory inside the declaring package.
 *
 * @category models
 * @since 0.1.0
 */
export interface Package {
  readonly _tag: "Package"
}

/**
 * Visible to the declaring directory and every directory below it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Subpackages {
  readonly _tag: "Subpackages"
}

/**
 * Visible anywhere in the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export interface Public {
  readonly _tag: "Public"
}

/**
 * Visible to the listed labels only.
 *
 * `labels` is deduplicated and keeps declaration order.
 *
 * @category models
 * @since 0.1.0
 */
export interface Labels {
  readonly _tag: "Labels"
  readonly labels: ReadonlyArray<string>
}

/**
 * Visible to every package whose manifest satisfies `where`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Group {
  readonly _tag: "Group"
  readonly where: (manifest: PackageManifest) => boolean
}

/**
 * Every visibility declaration a target can carry.
 *
 * @category models
 * @since 0.1.0
 */
export type Visibility = Private | Package | Subpackages | Public | Labels | Group

/**
 * Reads an own data property without invoking user code.
 *
 * Every caller checks {@link isPlainObject} first, so the object is not a
 * Proxy and reflection on it cannot run author code or throw.
 */
const ownData = (value: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/** Whether a value is a non-proxy, symbol-free object with a plain prototype. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.getOwnPropertySymbols(value).length === 0
}

/**
 * Returns the reason one visibility label is unusable, or undefined.
 *
 * The grammar is the label grammar the CLI parses, restricted to the
 * workspace-anchored forms: `//package`, `//package:target`, `//package/...`,
 * and `//...`. A relative `:target` is refused because a visibility list names
 * consumers in other packages, so a reader of the list has no package to
 * resolve it against.
 *
 * @category validation
 * @since 0.1.0
 */
export const labelFailure = (value: string): string | undefined => {
  if (value === "") return "is empty"
  if (!value.isWellFormed()) return "is not well-formed UTF-16"
  if (value.includes("\0")) return "contains a null byte"
  if (value.includes("\\")) return "uses a backslash separator"
  if (!value.startsWith("//")) return "does not start with //"
  const body = value.slice(2)
  if (body === "...") return undefined
  const rest = body.endsWith("/...") ? body.slice(0, -4) : body
  const colon = rest.indexOf(":")
  if (colon >= 0) {
    const target = rest.slice(colon + 1)
    if (target === "") return "names an empty target"
    if (target.includes(":")) return "carries more than one colon"
  }
  const packagePath = colon < 0 ? rest : rest.slice(0, colon)
  if (packagePath === "") return undefined
  for (const segment of packagePath.split("/")) {
    if (segment === "") return "has an empty path segment"
    // `...` is only a label at the end of a package path, where it is stripped
    // above. Anywhere else it is a directory name no package has.
    if (segment === "." || segment === ".." || segment === "...") {
      return `has the path segment ${JSON.stringify(segment)}`
    }
  }
  return undefined
}

/**
 * Visible to the declaring directory only. This is the default.
 *
 * Exported as `Visibility.private`. The binding is named `privateVisibility`
 * because `private` is a reserved word in a module, which is strict mode.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const own = Smithers.Visibility.private
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
const privateVisibility: Private = Object.freeze({ _tag: "Private" as const })

/**
 * Visible to every directory inside the declaring package.
 *
 * Exported as `Visibility.package`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const withinPackage = Smithers.Visibility.package
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
const packageVisibility: Package = Object.freeze({ _tag: "Package" as const })

/**
 * Visible to the declaring directory and every directory below it.
 *
 * Exported as `Visibility.subpackages`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const andBelow = Smithers.Visibility.subpackages
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
const subpackagesVisibility: Subpackages = Object.freeze({ _tag: "Subpackages" as const })

/**
 * Visible anywhere in the workspace.
 *
 * Exported as `Visibility.public`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const everywhere = Smithers.Visibility.public
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
const publicVisibility: Public = Object.freeze({ _tag: "Public" as const })

export {
  packageVisibility as package,
  privateVisibility as private,
  publicVisibility as public,
  subpackagesVisibility as subpackages
}

/**
 * Declares visibility to an explicit list of labels.
 *
 * Every label is checked against {@link labelFailure} at declaration time, so
 * a typo is reported where it is written rather than when enforcement runs.
 * Labels are deduplicated and keep declaration order.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const consumers = Smithers.Visibility.of("//packages/flow", "//packages/plan/...")
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const of = (...labels: ReadonlyArray<string>): Labels => {
  if (labels.length === 0) throw new Error("Visibility.of requires at least one label")
  const unique: Array<string> = []
  for (const label of labels) {
    if (typeof label !== "string") throw new TypeError("a visibility label must be a string")
    const failure = labelFailure(label)
    if (failure !== undefined) throw new Error(`visibility label ${JSON.stringify(label)} ${failure}`)
    if (!unique.includes(label)) unique.push(label)
  }
  return Object.freeze({ _tag: "Labels" as const, labels: Object.freeze(unique) })
}

/**
 * Declares visibility to every package whose manifest satisfies a predicate.
 *
 * The predicate is stored, never called: the manifest query that would supply
 * its argument is unbuilt, and calling it here would make BUILD.ts evaluation
 * depend on the filesystem. The options object is rejected when it is a Proxy
 * or carries a non-plain prototype, matching how `Target.make` refuses those
 * in attrs.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const engineTier = Smithers.Visibility.group({ where: (pkg) => pkg.smthrs.group === "engine" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const group = (
  options: { readonly where: (manifest: PackageManifest) => boolean }
): Group => {
  if (!isPlainObject(options)) {
    throw new TypeError("Visibility.group options must be a plain object")
  }
  const where = ownData(options, "where")
  if (typeof where !== "function" || NodeUtil.isProxy(where)) {
    throw new TypeError("Visibility.group requires a `where` predicate function")
  }
  return Object.freeze({ _tag: "Group" as const, where: where as Group["where"] })
}

/**
 * Checks whether a value is a well-formed visibility declaration.
 *
 * The check reads own data properties only, so an accessor or a Proxy cannot
 * run author code during validation.
 *
 * @category guards
 * @since 0.1.0
 */
export const isVisibility = (value: unknown): value is Visibility => {
  if (!isPlainObject(value)) return false
  const tag = ownData(value, "_tag")
  switch (tag) {
    case "Private":
    case "Package":
    case "Subpackages":
    case "Public":
      return true
    case "Labels": {
      const labels = ownData(value, "labels")
      if (!Array.isArray(labels) || NodeUtil.isProxy(labels)) return false
      return labels.every((label) => typeof label === "string" && labelFailure(label) === undefined)
    }
    case "Group": {
      const where = ownData(value, "where")
      return typeof where === "function" && !NodeUtil.isProxy(where)
    }
    default:
      return false
  }
}
