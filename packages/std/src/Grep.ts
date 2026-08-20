/**
 * The `grep` flow and its Flows Ripgrep Subset v1 contract.
 *
 * Supported ripgrep semantics: Rust-style regular expressions restricted to
 * Flows Ripgrep ASCII v1; `-F` (`fixedStrings`); `-i` (`ignoreCase`) and `-S`
 * (`smartCase`); ordered `-g` include/exclude globs; `-A`, `-B`, and `-C`
 * context; per-file `--max-count`; `--files-with-matches`; `--hidden`; and
 * deterministic path/line ordering. Ignore files and file-type registries are
 * outside v1: callers must use `noIgnore: true` (the default), and any `types`
 * request is rejected. Results are globally bounded by `limit` and disclose
 * truncation through `notice`.
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
  root: Schema.optional(Schema.String).annotate({ description: "Search root; defaults to /." }),
  fixedStrings: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -F." }),
  ignoreCase: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -i." }),
  smartCase: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -S." }),
  globs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Ordered ripgrep -g globs; prefix exclusions with !."
  }),
  beforeContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep -B."
  }),
  afterContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep -A."
  }),
  context: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({ description: "Ripgrep -C." }),
  maxCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep --max-count, per file."
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
  const fixedStrings = input.fixedStrings ?? false
  const patternError = Contract.validatePattern(input.pattern, fixedStrings)
  if (patternError !== undefined) return patternError
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
