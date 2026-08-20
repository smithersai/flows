/**
 * Edit flow declaration and portable handler.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Match from "./internal/Match.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the edit flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "edit"

/**
 * Model-facing description of the edit flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Edit a file by replacing an exact string; the match must be unique unless replaceAll is set, so include surrounding context."

/**
 * Input schema for the edit flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path of the file to edit" }),
  oldString: Schema.String.annotate({ description: "Exact text to replace, including surrounding context" }),
  newString: Schema.String.annotate({ description: "Replacement text" }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({ description: "Replace every occurrence instead of one" })
})

/**
 * Output schema for the edit flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  path: Schema.String.annotate({ description: "Path that was edited" }),
  replacements: Schema.Number.annotate({ description: "Number of occurrences replaced" })
})

/**
 * Static conservative effect envelope for the edit flow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "compensable", mode: "hermetic", reads: ["/**"], writes: ["/**"] })

/**
 * Narrows the edit effect envelope to one input path.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({ tier: "compensable", mode: "hermetic", reads: [input.path], writes: [input.path] })

/**
 * Capabilities required by the edit flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:read", "/**"), capability("fs:write", "/**")]

/**
 * Declaration-only edit flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Applies an exact-string edit through the permission-aware kernel filesystem.
 *
 * A non-unique match is a failure rather than a silent first-match edit: the
 * model cannot see which occurrence it would have changed.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Edit.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  if (input.oldString === "") {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: "oldString must not be empty; use the write flow to create a file",
        path: input.path
      })
    )
  }
  const content = yield* fileSystem.readFileString(input.path).pipe(
    Effect.mapError(() =>
      new StdError.StdError({ code: "not_found", message: `File not found: ${input.path}`, path: input.path })
    )
  )
  // Tolerant location: exact first, then whitespace-forgiving line matches.
  // The replacement text is always the caller's newString; the cascade only
  // finds where the caller's quoted block actually sits.
  const located = Match.locate(content, input.oldString)
  if (located.length === 0) {
    const nearest = Match.nearestRegion(content, input.oldString)
    return yield* Effect.fail(
      new StdError.StdError({
        code: "no_match",
        message: nearest === undefined
          ? `oldString does not occur in ${input.path}, and no line of it matches either — is this the right file?`
          : `oldString does not occur in ${input.path}. The nearest actual region is:\n${nearest}\nQuote it exactly and reissue the edit.`,
        path: input.path
      })
    )
  }
  const count = located.length
  if (count > 1 && input.replaceAll !== true) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: `oldString occurs ${count} times in ${input.path}; add context or set replaceAll`,
        path: input.path
      })
    )
  }
  const targets = input.replaceAll === true ? located : [located[0]!]
  let replaced = ""
  let cursor = 0
  for (const span of targets) {
    replaced += content.slice(cursor, span.start) + input.newString
    cursor = span.end
  }
  replaced += content.slice(cursor)
  yield* fileSystem.writeFileString(input.path, replaced).pipe(
    Effect.mapError(() =>
      new StdError.StdError({
        code: "command_failed",
        message: `Could not write ${input.path}`,
        path: input.path
      })
    )
  )
  return { path: input.path, replacements: input.replaceAll === true ? count : 1 }
})
