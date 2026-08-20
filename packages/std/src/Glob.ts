/**
 * The `glob` projection of Flows Ripgrep Subset v1.
 *
 * It has the same two peer implementations as `grep` and corresponds to
 * `rg --files -g`: `*`, `**`, `?`, and brace alternatives are supported;
 * results are path sorted; hidden files are opt-in; ignore files are disabled;
 * and the fixed skip-directory convention still permits an explicitly named
 * skipped directory as the root.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import { Effect, Schema } from "effect"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Contract from "./internal/SearchContract.ts"
import { MAX_ENTRIES } from "./internal/Text.ts"
import * as Search from "./Search.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name for glob.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "glob"
/**
 * The model-facing glob description.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description = "Find files through the Flows Ripgrep Subset v1 contract."
/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  pattern: Schema.NonEmptyString.annotate({ description: "Ripgrep -g pattern supporting *, **, ?, and {a,b}." }),
  root: Schema.optional(Schema.String).annotate({ description: "Search root; defaults to /." }),
  hidden: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --hidden." }),
  noIgnore: Schema.optional(Schema.Boolean).annotate({
    description: "Must be true in v1; ignore files are not consulted."
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Maximum paths, capped at ${MAX_ENTRIES}.`
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
 * Capability strings requested by glob.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:read", "/**")]
/**
 * Declaration-only glob flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Runs one `rg --files -g` contract call through the selected peer implementation.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Glob.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, Search.Search> {
  if (input.noIgnore === false) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: "Invalid ripgrep options: ignore-file handling is not supported; use noIgnore: true"
      })
    )
  }
  const patternError = Contract.validateGlob(input.pattern)
  if (patternError !== undefined) return yield* Effect.fail(patternError)
  const search = yield* Search.Search
  return yield* search.glob({
    pattern: input.pattern,
    root: input.root ?? "/",
    hidden: input.hidden ?? false,
    limit: Math.min(input.limit ?? MAX_ENTRIES, MAX_ENTRIES)
  })
})
