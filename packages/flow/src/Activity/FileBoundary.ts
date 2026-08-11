// Deep reviewed and polished by a human on 2026-08-10.

/**
 * An activity's declaration of which files it reads and which it may write.
 *
 * The declaration is what makes a step hermetic enough to cache: the read set
 * is the dependency edge set folded into the step key, and the write set is
 * what the host measures the execution against afterwards. `boundaryMode`
 * decides what happens when the two disagree — a hard boundary refuses the
 * result, an expected one records the deviation and carries on.
 *
 * @since 0.1.0
 */
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
