/**
 * The `grep` flow: content search over the workspace, with a deterministic
 * order and both a match count and a byte budget bounding the output.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import { MAX_GREP_MATCHES, notice, truncateBytes } from "./internal/Text.ts"
import * as Walk from "./internal/Walk.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name for the grep flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "grep"

/**
 * Searches file contents by regex below a root; binary files are skipped and counted rather than returned.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Search file contents by regex below a root; binary files are skipped and counted rather than returned."

/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Regular expression, or literal text when literal is true." }),
  root: Schema.optional(Schema.String).annotate({ description: "Directory to search; defaults to /." }),
  include: Schema.optional(Schema.String).annotate({ description: "Filename glob filter." }),
  literal: Schema.optional(Schema.Boolean).annotate({ description: "Treat pattern as literal text." }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Maximum matches to return, capped at ${MAX_GREP_MATCHES}.`
  })
})

const Match = Schema.Struct({ file: Schema.String, line: Schema.Int, text: Schema.String })

/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  matches: Schema.Array(Match),
  filesSearched: Schema.Int,
  skippedBinary: Schema.Int,
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
 * Declaration-only grep flow. Execute {@link run} through the builtin handler map.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const invalidPattern = (pattern: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_pattern", message: `Invalid regular expression: ${pattern}` })

const fileSystemError = (path: string): StdError.StdError =>
  new StdError.StdError({ code: "not_found", message: `Path not found: ${path}`, path })

const escapeRegularExpression = (value: string): string => value.replace(/[.*+^${}()|[\]\\]/g, "\\$&")

const segmentExpression = (segment: string): RegExp => {
  let expression = ""
  for (const character of segment) {
    expression += character === "*"
      ? ".*"
      : character === "?"
      ? "."
      : character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  }
  return new RegExp(`^${expression}$`)
}

const includesFile = (pattern: string, relative: string, basename: string): boolean =>
  segmentExpression(pattern).test(relative) || segmentExpression(pattern).test(basename)

const walkFiles = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string
): Effect.Effect<ReadonlyArray<string>, StdError.StdError> =>
  Effect.gen(function*() {
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
    return files.sort()
  })

const preview = (line: string): string => {
  const characters = Array.from(line)
  const capped = characters.length > 500 ? characters.slice(0, 500).join("") : line
  return truncateBytes(capped, 500, { keep: "head" }).text
}

/**
 * Searches text files with a portable regular expression using only kernel filesystem and path services.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Grep.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const expression = yield* Effect.try({
    try: () => new RegExp(input.literal === true ? escapeRegularExpression(input.pattern) : input.pattern),
    catch: () => invalidPattern(input.pattern)
  })
  const path = yield* Path.Path
  const root = path.normalize(input.root ?? "/")
  const fileSystem = yield* FileSystem.FileSystem
  const rootInfo = yield* fileSystem.stat(root).pipe(Effect.mapError(() => fileSystemError(root)))
  const files = yield* walkFiles(fileSystem, path, root)
  const limit = Math.min(input.limit ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES)
  const matches: Array<{ readonly file: string; readonly line: number; readonly text: string }> = []
  let matchCount = 0
  let filesSearched = 0
  let skippedBinary = 0

  for (const file of files) {
    const relative = path.relative(root, file)
    if (input.include !== undefined && !includesFile(input.include, relative, path.basename(file))) continue
    const bytes = yield* fileSystem.readFile(file).pipe(Effect.mapError(() => fileSystemError(file)))
    filesSearched++
    if (bytes.includes(0)) {
      if (rootInfo.type === "File" && file === root) {
        return yield* Effect.fail(
          new StdError.StdError({ code: "binary_file", message: `Cannot search binary file: ${file}`, path: file })
        )
      }
      skippedBinary++
      continue
    }
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index]
      if (text === undefined) continue
      expression.lastIndex = 0
      if (!expression.test(text)) continue
      matchCount++
      // Retain one additional match before slicing so truncation is evidence-based.
      if (matches.length <= limit) matches.push({ file, line: index + 1, text: preview(text) })
    }
  }

  const truncated = matchCount > limit
  const shown = matches.slice(0, limit)
  return {
    matches: shown,
    filesSearched,
    skippedBinary,
    truncated,
    ...(truncated ? { notice: notice("matches", shown.length, matchCount) } : {})
  }
})
