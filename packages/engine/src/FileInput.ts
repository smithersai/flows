import * as Schema from "effect/Schema"

/**
 * Schema for an input file path paired with its measured content digest.
 *
 * @category models
 * @since 0.1.0
 */
export const FileInput = Schema.Struct({
  /** Non-empty path of the input file. */
  path: Schema.NonEmptyString,
  /** Non-empty digest observed for the file contents. */
  digest: Schema.NonEmptyString
})

/**
 * An input file path paired with its measured content digest.
 *
 * @category models
 * @since 0.1.0
 */
export type FileInput = typeof FileInput.Type
