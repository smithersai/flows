// Deep reviewed and polished by a human on 2026-08-10.

import * as Schema from "effect/Schema"
import { BoundaryMode } from "./BoundaryMode.ts"
import { FileInput } from "./FileInput.ts"

/**
 * Schema for the filesystem boundary of an activity.
 *
 * @category models
 * @since 0.1.0
 */
export const FileBoundary = Schema.Struct({
  /** Files read by the activity and the digests observed for them. */
  readSet: Schema.Array(FileInput),
  /** Files or patterns the activity is allowed to write. */
  writeSet: Schema.Array(Schema.NonEmptyString),
  /** Whether undeclared access is rejected immediately or validated later. */
  boundaryMode: BoundaryMode
})

/**
 * The filesystem boundary of an activity.
 *
 * @category models
 * @since 0.1.0
 */
export type FileBoundary = typeof FileBoundary.Type
