/**
 * The `grep` flow and its Flows Ripgrep Subset v1 contract.
 *
 * Supported ripgrep semantics: Rust-style regular expressions restricted to
 * Flows Ripgrep ASCII v1; `-F` (`fixedStrings`); `-i` (`ignoreCase`) and `-S`
 * (`smartCase`); ordered `-g` include/exclude globs; `-A`, `-B`, and `-C`
 * context; per-file `--max-count`; `--files-with-matches`; `--hidden`; and
 * deterministic path/line ordering. Ignore files and file-type registries are
 * outside v1: callers must use `noIgnore: true` (the default), and any `types`
 * request is rejected. Patterns are capped at 4096 ASCII bytes and counted
 * repetitions at 1000. Invalid UTF-8 is replacement-decoded; NUL-bearing
 * files are skipped and counted, while an explicitly named binary file is a
 * typed failure. Results are globally bounded by `limit` and disclose
 * truncation through `notice`.
 *
 * `globs` accepts exactly the shapes `glob` accepts and reads them the same
 * way: every pattern is matched against each candidate's path *relative to
 * `root`*, a pattern without `/` matches the basename at any depth, and a
 * leading `/` or `./` anchors at the root rather than naming a filesystem
 * absolute path. A `root` that names one file is searched whatever the globs
 * say. See `Glob` for the full statement of the rules. A search that matched
 * nothing because a positive glob was unsatisfiable says so through `notice`
 * instead of returning a silent empty result.
 *
 * `filesSearched` counts every file the globs admitted, including the binaries
 * `skippedBinary` reports and any file the process could not open. A walk
 * skips what it cannot read rather than failing the call.
 *
 * Native and in-process implementations are peers behind `Search.Search`.
 * This module declares and validates the call; it performs no host access.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import { Effect, Schema } from "effect"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Contract from "./internal/SearchContract.ts"
import { MAX_GREP_MATCHES } from "./internal/Text.ts"
import * as Search from "./Search.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name for grep.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "grep"
/**
 * The model-facing grep description.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description = "Search file contents through the Flows Ripgrep Subset v1 contract."

/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Flows Ripgrep ASCII v1 expression." }),
  root: Schema.optional(Schema.String).annotate({
    description: "Search root the globs are relative to; defaults to /. Pass the project directory."
  }),
  fixedStrings: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -F." }),
  ignoreCase: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -i." }),
  smartCase: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -S." }),
  globs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Ordered ripgrep -g globs, matched against paths relative to root, never absolute paths: a glob without / matches any basename, a leading / anchors at root, and ** crosses directories. Prefix exclusions with !."
  }),
  beforeContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep -B."
  }),
  afterContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep -A."
  }),
  context: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({ description: "Ripgrep -C." }),
  maxCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Ripgrep --max-count, per file; at least 1."
  }),
  filesWithMatches: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --files-with-matches." }),
  hidden: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --hidden." }),
  noIgnore: Schema.optional(Schema.Boolean).annotate({
    description: "Must be true in v1; ignore files are not consulted."
  }),
  types: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Reserved; file-type registries are not supported in v1."
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Global result limit, capped at ${MAX_GREP_MATCHES}.`
  })
})

/**
 * One matching or context line.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Match = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  text: Schema.String,
  kind: Schema.Literals(["match", "context"])
})

/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  matches: Schema.Array(Match),
  files: Schema.Array(Schema.String),
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
 * Capability strings requested by grep.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:read", "/**")]
/**
 * Declaration-only grep flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const normalize = (input: typeof Input.Type): Search.GrepInput | StdError.StdError => {
  if (input.noIgnore === false) {
    return Contract.invalidInput("ignore-file handling is not supported; use noIgnore: true")
  }
  if (input.types !== undefined && input.types.length > 0) {
    return Contract.invalidInput("file type filters are not supported")
  }
  if (input.ignoreCase === true && input.smartCase === true) {
    return Contract.invalidInput("-i and -S are mutually exclusive")
  }
  if (input.context !== undefined && (input.beforeContext !== undefined || input.afterContext !== undefined)) {
    return Contract.invalidInput("-C cannot be combined with -A or -B")
  }
  // `rg --max-count 0` answers nothing at all, not even the summary the native
  // peer parses, so a cap that admits no match is rejected rather than read
  // differently by each peer.
  if (input.maxCount !== undefined && input.maxCount < 1) {
    return Contract.invalidInput("--max-count must be at least 1")
  }
  const fixedStrings = input.fixedStrings ?? false
  const patternError = Contract.validatePattern(input.pattern, fixedStrings)
  if (patternError !== undefined) return patternError
  for (const glob of input.globs ?? []) {
    const globError = Contract.validateGlob(glob)
    if (globError !== undefined) return globError
  }
  return {
    pattern: input.pattern,
    root: input.root ?? "/",
    fixedStrings,
    ignoreCase: input.ignoreCase ?? false,
    smartCase: input.smartCase ?? false,
    globs: input.globs ?? [],
    beforeContext: input.context ?? input.beforeContext ?? 0,
    afterContext: input.context ?? input.afterContext ?? 0,
    maxCount: input.maxCount,
    filesWithMatches: input.filesWithMatches ?? false,
    hidden: input.hidden ?? false,
    limit: Math.min(input.limit ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES)
  }
}

/**
 * Runs one validated ripgrep-contract call through the selected peer implementation.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Grep.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, Search.Search> {
  const normalized = normalize(input)
  if (normalized instanceof StdError.StdError) return yield* Effect.fail(normalized)
  const search = yield* Search.Search
  return yield* search.grep(normalized)
})
