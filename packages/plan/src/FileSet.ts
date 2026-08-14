/**
 * Static filesystem declaration vocabulary shared by planning and execution.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/** Workspace-relative glob pattern.
 * @category schemas
 * @since 0.1.0
 */
export const Pattern = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (pattern) =>
      !pattern.startsWith("/") &&
        !pattern.replaceAll("\\", "/").split("/").some((segment) => segment === "..") ||
      "file patterns must be workspace-relative and cannot traverse upward",
    { title: "workspaceRelativePattern" }
  )
)

/** Bazel-style file glob.
 * @category schemas
 * @since 0.1.0
 */
export const Glob = Schema.TaggedStruct("Glob", {
  include: Schema.NonEmptyArray(Pattern),
  exclude: Schema.optional(Schema.Array(Pattern))
})

/** Bazel-style file glob.
 * @category models
 * @since 0.1.0
 */
export type Glob = typeof Glob.Type

/** A directory output captured and replayed as one tree artifact.
 * @category schemas
 * @since 0.1.0
 */
export const TreeArtifact = Schema.TaggedStruct("TreeArtifact", {
  path: Pattern
})

/** A directory output captured and replayed as one tree artifact.
 * @category models
 * @since 0.1.0
 */
export type TreeArtifact = typeof TreeArtifact.Type

/** One leaf of a named filegroup.
 * @category schemas
 * @since 0.1.0
 */
export const Entry = Schema.Union([Schema.NonEmptyString, Glob, TreeArtifact])

/** One leaf of a named filegroup.
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type

/** A declaration valid in a read set.
 * @category schemas
 * @since 0.1.0
 */
export const ReadEntry = Schema.Union([Schema.NonEmptyString, Glob])

/** A declaration valid in a read set.
 * @category models
 * @since 0.1.0
 */
export type ReadEntry = typeof ReadEntry.Type

/** A named reusable collection expanded before measurement.
 * @category schemas
 * @since 0.1.0
 */
export const Filegroup = Schema.TaggedStruct("Filegroup", {
  name: Schema.NonEmptyString,
  entries: Schema.Array(Entry)
})

/** A named reusable collection expanded before measurement.
 * @category models
 * @since 0.1.0
 */
export type Filegroup = typeof Filegroup.Type

/** A named read-only collection.
 * @category schemas
 * @since 0.1.0
 */
export const ReadFilegroup = Schema.TaggedStruct("Filegroup", {
  name: Schema.NonEmptyString,
  entries: Schema.Array(ReadEntry)
})

/** A named read-only collection.
 * @category models
 * @since 0.1.0
 */
export type ReadFilegroup = typeof ReadFilegroup.Type

/** Any declaration accepted by a plan effect set.
 * @category schemas
 * @since 0.1.0
 */
export const Declaration = Schema.Union([Entry, Filegroup])

/** Any declaration accepted by a plan effect set.
 * @category models
 * @since 0.1.0
 */
export type Declaration = typeof Declaration.Type

/** Any declaration accepted by a plan read set.
 * @category schemas
 * @since 0.1.0
 */
export const ReadDeclaration = Schema.Union([ReadEntry, ReadFilegroup])

/** Any declaration accepted by a plan read set.
 * @category models
 * @since 0.1.0
 */
export type ReadDeclaration = typeof ReadDeclaration.Type

/** Creates a named filegroup.
 * @category constructors
 * @since 0.1.0
 */
export const makeFilegroup = (name: string, entries: ReadonlyArray<Entry>): Filegroup => ({
  _tag: "Filegroup",
  name,
  entries
})

/** Expands filegroups deterministically, preserving declaration order.
 * @category accessors
 * @since 0.1.0
 */
export const expand = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<Entry> =>
  declarations.flatMap((declaration) =>
    typeof declaration !== "string" && declaration._tag === "Filegroup" ? declaration.entries : [declaration]
  )

/** Expands read filegroups deterministically, preserving declaration order.
 * @category accessors
 * @since 0.1.0
 */
export const expandReads = (declarations: ReadonlyArray<ReadDeclaration>): ReadonlyArray<ReadEntry> =>
  declarations.flatMap((declaration) =>
    typeof declaration !== "string" && declaration._tag === "Filegroup" ? declaration.entries : [declaration]
  )

/** Whether a value is a glob declaration.
 * @category guards
 * @since 0.1.0
 */
export const isGlob = (value: unknown): value is Glob =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "Glob"

/** Whether a value is a tree artifact declaration.
 * @category guards
 * @since 0.1.0
 */
export const isTreeArtifact = (value: unknown): value is TreeArtifact =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "TreeArtifact"

const escape = (value: string): string => value.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")

/** Compiles Bazel's `*`/`**` path semantics without permitting traversal. */
const patternExpression = (pattern: string): RegExp => {
  const segments = pattern.replaceAll("\\", "/").split("/")
  let source = "^"
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment === "**") {
      source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*"
      continue
    }
    source += escape(segment).replaceAll("*", "[^/]*")
    if (index < segments.length - 1) source += "/"
  }
  return new RegExp(`${source}$`)
}

/** Tests one workspace-relative path against one Bazel-style pattern.
 * @category predicates
 * @since 0.1.0
 */
export const matchesPattern = (pattern: string, path: string): boolean => patternExpression(pattern).test(path)

/** Tests one file path against a glob, including exclusions.
 * @category predicates
 * @since 0.1.0
 */
export const matchesGlob = (glob: Glob, path: string): boolean =>
  glob.include.some((pattern) => matchesPattern(pattern, path)) &&
  !(glob.exclude ?? []).some((pattern) => matchesPattern(pattern, path))

const beneath = (tree: string, path: string): boolean => path === tree || path.startsWith(`${tree}/`)

/**
 * Conservative static overlap. `true` may over-serialize; `false` proves that
 * no path can belong to both declarations.
 *
 * @category predicates
 * @since 0.1.0
 */
export const overlaps = (left: Entry, right: Entry): boolean => {
  if (typeof left === "string" && typeof right === "string") return left === right
  if (typeof left === "string" && isGlob(right)) return matchesGlob(right, left)
  if (isGlob(left) && typeof right === "string") return matchesGlob(left, right)
  if (isGlob(left) && isGlob(right)) return true
  if (isTreeArtifact(left) && typeof right === "string") return beneath(left.path, right)
  if (typeof left === "string" && isTreeArtifact(right)) return beneath(right.path, left)
  if (isTreeArtifact(left) && isTreeArtifact(right)) {
    return beneath(left.path, right.path) || beneath(right.path, left.path)
  }
  if (isTreeArtifact(left) && isGlob(right)) return true
  /* v8 ignore else -- the closed Entry union leaves only Glob/TreeArtifact here */
  if (isGlob(left) && isTreeArtifact(right)) return overlaps(right, left)
  /* v8 ignore next -- Entry's closed union makes every pair return above */
  return true
}
