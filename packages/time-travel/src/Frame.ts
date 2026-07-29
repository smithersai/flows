import * as Schema from "effect/Schema"

/** @since 0.1.0 @category schemas */
export const Frame = Schema.Struct({
  lineageId: Schema.NonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
/** @since 0.1.0 @category models */
export type Frame = typeof Frame.Type
/** @since 0.1.0 @category schemas */
export const LineageEdgeKind = Schema.Literals(["child", "fork", "continuation"])
/** @since 0.1.0 @category models */
export type LineageEdgeKind = typeof LineageEdgeKind.Type
/** @since 0.1.0 @category models */
export interface LineageEdge {
  readonly parentRunId: string
  readonly parentSeq: number
  readonly childRunId: string
  readonly kind: LineageEdgeKind
  readonly attached: boolean
}
