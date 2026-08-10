// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Races activities through durable deferred execution.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as DurableDeferred from "../DurableDeferred.ts"
import type { FlowEngine, FlowInstance } from "../FlowEngine.ts"
import type { Activity, Any } from "./Activity.ts"

/**
 * Runs a non-empty collection of activities as a durable race and returns the
 * first completed success or failure using unioned success and error schemas.
 *
 * @category racing
 * @since 4.0.0
 */
export const raceAll = <const Activities extends NonEmptyReadonlyArray<Any>>(
  name: string,
  activities: Activities
): Effect.Effect<
  Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _A["Type"] : never,
  Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _E["Type"] : never,
  | (Activities[number] extends Activity<infer Success, infer Error, infer R>
    ? Success["DecodingServices"] | Error["DecodingServices"] | R
    : never)
  | FlowEngine
  | FlowInstance
> =>
  DurableDeferred.raceAll({
    name: `Activity/${name}`,
    success: Schema.Union(
      activities.map((activity) => (activity as any).successSchema)
    ),
    error: Schema.Union(
      activities.map((activity) => (activity as any).errorSchema)
    ),
    effects: activities.map((activity) => (activity as any)) as any
  }) as any
