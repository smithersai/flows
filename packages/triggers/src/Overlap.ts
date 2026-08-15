/**
 * Pure overlap policy decisions.
 *
 * @since 0.1.0
 */
import type { Overlap as Policy } from "./Trigger.ts"

/** @category models @since 0.1.0 */
export interface State {
  readonly running: boolean
  readonly pending?: number | undefined
  readonly due: number
}
/** @category models @since 0.1.0 */
export type Action = "fire" | "skip" | "buffer" | "supersede"

/** @category decision @since 0.1.0 */
export const decide = (policy: Policy, state: State): Action => {
  if (!state.running) return "fire"
  switch (policy) {
    case "skip":
      return "skip"
    case "buffer-one":
      return "buffer"
    case "supersede":
      return "supersede"
  }
}

/** @category decision @since 0.1.0 */
export const pendingAfter = (state: State): number => Math.max(state.pending ?? Number.NEGATIVE_INFINITY, state.due)
