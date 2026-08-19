/**
 * The `glob` flow: filename pattern matching over the workspace, with a
 * deterministic order and a bounded result count.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import { MAX_ENTRIES, notice } from "./internal/Text.ts"
import * as Walk from "./internal/Walk.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name for the glob flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "glob"

/**
 * Finds files matching a glob below a root; results are path-sorted because filesystem mtimes are not useful in every host.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Find files matching a glob below a root; results are path-sorted because filesystem mtimes are not useful in every host."

/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  pattern: Schema.NonEmptyString.annotate({ description: "Glob pattern supporting *, **, ?, and {a,b}." }),
  root: Schema.optional(Schema.String).annotate({ description: "Directory to search; defaults to /." }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Maximum paths to return, capped at ${MAX_ENTRIES}.`
  })
})

/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  paths: Schema.Array(Schema.String),
  total: Schema.Int,
  truncated: Schema.Boolean,
  notice: Schema.optional(Schema.String)
})

const rootSubtree = (root: string): string => root === "/" ? "/**" : `${root.replace(/\/+$/, "")}/**`

/**
 * Conservative sealed declaration for all workspace files.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "sealed", mode: "hermetic", reads: ["/**"], writes: [] })

/**
 * Narrows the read declaration to the requested root subtree.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (input: { readonly root?: string | undefined }) =>
  envelope({ tier: "sealed", mode: "hermetic", reads: [rootSubtree(input.root ?? "/")], writes: [] })

/**
 * Capability strings requested by this flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:read", "/**")]

/**
 * Declaration-only glob flow. Execute {@link run} through the builtin handler map.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const invalidPattern = (pattern: string, message: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_pattern", message: `Invalid glob pattern "${pattern}": ${message}` })

const fileSystemError = (path: string): StdError.StdError =>
  new StdError.StdError({ code: "not_found", message: `Path not found: ${path}`, path })

const expandBraces = (pattern: string): ReadonlyArray<string> | StdError.StdError => {
  let opening = -1
  let depth = 0
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "{") {
      if (depth === 0) opening = index
      depth++
    } else if (character === "}") {
      if (depth === 0) return invalidPattern(pattern, "unexpected }")
      depth--
      if (depth === 0) {
        const body = pattern.slice(opening + 1, index)
        const alternatives = body.split(",")
        if (alternatives.length < 2 || alternatives.some((alternative) => alternative.length === 0)) {
          return invalidPattern(pattern, "braces require at least two non-empty alternatives")
        }
        const expanded: Array<string> = []
        for (const alternative of alternatives) {
          const next = expandBraces(`${pattern.slice(0, opening)}${alternative}${pattern.slice(index + 1)}`)
          if (next instanceof StdError.StdError) return next
          expanded.push(...next)
        }
        return expanded
      }
    }
  }
  return depth === 0 ? [pattern] : invalidPattern(pattern, "unclosed {")
}

const segmentExpression = (segment: string): RegExp => {
  let expression = ""
  for (const character of segment) {
    expression += character === "*"
      ? "[^/]*"
      : character === "?"
      ? "[^/]"
      : character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  }
  return new RegExp(`^${expression}$`)
}

const matches = (pattern: string, value: string): boolean => {
  const patternSegments = pattern.split("/").filter((segment) => segment.length > 0)
  const valueSegments = value.split("/").filter((segment) => segment.length > 0)
  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const segment = patternSegments[patternIndex]
    if (segment === undefined) return valueIndex === valueSegments.length
    if (segment === "**") {
      return visit(patternIndex + 1, valueIndex) ||
        (valueIndex < valueSegments.length && visit(patternIndex, valueIndex + 1))
    }
    const valueSegment = valueSegments[valueIndex]
    return valueSegment !== undefined && segmentExpression(segment).test(valueSegment) &&
      visit(patternIndex + 1, valueIndex + 1)
  }
  return visit(0, 0)
}

const walkFiles = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string
): Effect.Effect<ReadonlyArray<string>, StdError.StdError> =>
  Effect.gen(function*() {
    // The kernel exposes glob, but the browser filesystem deliberately does
    // not implement it; traversal keeps this handler portable across hosts.
    const rootInfo = yield* fileSystem.stat(root).pipe(Effect.mapError(() => fileSystemError(root)))
    if (rootInfo.type === "File") return [path.normalize(root)]

    const files: Array<string> = []
    const directories: Array<string> = [root]
    while (directories.length > 0) {
      const directory = directories.pop()
      if (directory === undefined) continue
      const children = yield* fileSystem.readDirectory(directory).pipe(
        Effect.mapError(() => fileSystemError(directory))
      )
      for (const child of [...children].sort().reverse()) {
        if (Walk.skippedDirectories.has(child)) continue
        const candidate = path.join(directory, child)
        const info = yield* fileSystem.stat(candidate).pipe(Effect.mapError(() => fileSystemError(candidate)))
        if (info.type === "Directory") directories.push(candidate)
        else if (info.type === "File") files.push(path.normalize(candidate))
      }
    }
    return files
  })

/**
 * Finds files matching a portable glob using only kernel filesystem and path services.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Glob.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path
  const root = path.normalize(input.root ?? "/")
  const expanded = expandBraces(input.pattern)
  if (expanded instanceof StdError.StdError) return yield* Effect.fail(expanded)
  const files = yield* walkFiles(yield* FileSystem.FileSystem, path, root)
  const matching = files.filter((file) => {
    const relative = path.relative(root, file)
    return expanded.some((pattern) => matches(pattern, relative))
  }).sort()
  const limit = Math.min(input.limit ?? MAX_ENTRIES, MAX_ENTRIES)
  const truncated = matching.length > limit
  const paths = matching.slice(0, limit)
  return {
    paths,
    total: matching.length,
    truncated,
    ...(truncated ? { notice: notice("entries", paths.length, matching.length) } : {})
  }
})
