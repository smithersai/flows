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

const occurrences = (haystack: string, needle: string): number => needle === "" ? 0 : haystack.split(needle).length - 1

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
  const count = occurrences(content, input.oldString)
  if (count === 0) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "no_match",
        message: `oldString does not occur in ${input.path}`,
        path: input.path
      })
    )
  }
  if (count > 1 && input.replaceAll !== true) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: `oldString occurs ${count} times in ${input.path}; add context or set replaceAll`,
        path: input.path
      })
    )
  }
  const replaced = input.replaceAll === true
    ? content.split(input.oldString).join(input.newString)
    : content.replace(input.oldString, input.newString)
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
