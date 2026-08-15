/**
 * The append-only journal port — the chain's only state.
 *
 * The in-memory layer is a deletable stand-in for the flows engine journal:
 * the e2e suite asserts journal contents, not this API, so the suite
 * survives the engine swap (`docs/specs/Concepts/Chain Slice.md`).
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import type * as Event from "./Event.ts"

/** @category errors @since 0.1.0 */
export class JournalError extends Schema.TaggedErrorClass<JournalError>()("/chain/JournalError", {
  code: Schema.Literal("journal_unavailable").pipe(
    Schema.withConstructorDefault(Effect.succeed("journal_unavailable"))
  ),
  message: Schema.String
}) {}

/** @category services @since 0.1.0 */
export interface Service {
  readonly append: (event: Event.Event) => Effect.Effect<void, JournalError>
  readonly read: Effect.Effect<ReadonlyArray<Event.Event>, JournalError>
}

/** @category services @since 0.1.0 */
export class Journal extends Context.Service<Journal, Service>()("/chain/Journal") {}

/** @category constructors @since 0.1.0 */
export const make = (implementation: Service): Service => Journal.of(implementation)

const unavailable = (operation: string): JournalError => new JournalError({ message: `${operation} is unavailable` })

/** @category constructors @since 0.1.0 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    append: Effect.fn("Journal.append")(() => Effect.fail(unavailable("append"))),
    read: Effect.fail(unavailable("read")),
    ...overrides
  })

/** @category layers @since 0.1.0 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Journal> =>
  Layer.succeed(Journal)(makeNoop(overrides))

/**
 * An in-memory journal over a `Ref`, optionally seeded with prior events —
 * the seed is how tests replay and resume a chain.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory = (initial: ReadonlyArray<Event.Event> = []): Layer.Layer<Journal> =>
  Layer.effect(Journal)(
    Effect.gen(function*() {
      const ref = yield* Ref.make<ReadonlyArray<Event.Event>>(initial)
      return make({
        append: Effect.fn("Journal.append")((event) => Ref.update(ref, (events) => [...events, event])),
        read: Ref.get(ref)
      })
    })
  )
