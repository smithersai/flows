/**
 * The catalog of entries a script may call — gate 3 is membership in it.
 *
 * Every effect goes through this one door: a call names a visible entry,
 * pinned by its declaration digest, and settles as a journaled event
 * (`docs/specs/Concepts/Chain Slice.md`, `docs/specs/Concepts/Flow
 * Registry.md`).
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import { Clock, Context, type Effect, Layer, Random, Schema } from "effect"

/** @category errors @since 0.1.0 */
export class CallError extends Schema.TaggedErrorClass<CallError>()("/chain/CallError", {
  name: Schema.String,
  message: Schema.String,
  /**
   * The underlying stable code when the failing subsystem has one (a
   * memory error code, a permission verdict), so callers branch on it
   * rather than parsing prose.
   */
  cause: Schema.optional(Schema.String)
}) {}

/**
 * Where a call sits in its chain — handed to every handler so entries
 * that spawn scoped work (sub-chains) can derive deterministic child
 * identities from the slot.
 *
 * @category models
 * @since 0.1.0
 */
export interface CallSlot {
  readonly chain: string
  readonly link: number
  readonly ordinal: number
}

/** @category models @since 0.1.0 */
export interface Entry {
  readonly name: string
  readonly description: string
  readonly handler: (payload: unknown, slot?: CallSlot) => Effect.Effect<unknown, CallError>
  /**
   * An optional declaration digest overriding the default name+description
   * digest — richer catalogs (the registry) pin their full declaration.
   */
  readonly digest?: string | undefined
  /**
   * The capabilities this entry claims, as `action:resource` strings the
   * envelope seam evaluates per call. Undeclared is conservatively the
   * broadest claim — it asks under rules, never silently passes.
   */
  readonly capabilities?: ReadonlyArray<string> | undefined
}

/** @category services @since 0.1.0 */
export interface Service {
  readonly entries: ReadonlyArray<Entry>
  readonly lookup: (name: string) => Entry | undefined
}

/** @category services @since 0.1.0 */
export class Catalog extends Context.Service<Catalog, Service>()("/chain/Catalog") {}

/**
 * The declaration digest that pins an entry's identity into every call key
 * that names it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const entryDigest = (entry: Entry): string =>
  // An empty override falls back too: every call key pins a non-empty
  // digest, whatever the host supplied. Declared capabilities are part
  // of the declaration: narrowing or widening a claim re-keys the calls
  // settled under it.
  entry.digest !== undefined && entry.digest !== ""
    ? entry.digest
    : Digest.digest(Digest.canonical({
      capabilities: entry.capabilities ?? null,
      description: entry.description,
      name: entry.name
    }))

/** @category constructors @since 0.1.0 */
export const make = (entries: ReadonlyArray<Entry>): Service => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  return Catalog.of({
    entries,
    lookup: (name) => byName.get(name)
  })
}

/**
 * The system entries every sealed realm relies on: time and randomness as
 * ordinary journaled calls, so replay is deterministic with no special
 * identity (`docs/specs/Concepts/Chain Harness Build.md`, PR 3).
 *
 * @category constructors
 * @since 0.1.0
 */
export const system: ReadonlyArray<Entry> = [
  {
    // The empty claim set is deliberate: these are the harness's own
    // journaled reads, claiming no external authority, so the envelope
    // seam has nothing to evaluate and every ruleset admits them.
    capabilities: [],
    description: "The current wall-clock time in epoch milliseconds, journaled for replay",
    handler: () => Clock.currentTimeMillis,
    name: "sys/now"
  },
  {
    capabilities: [],
    description: "A uniform random number in [0, 1), journaled for replay",
    handler: () => Random.next,
    name: "sys/random"
  }
]

/**
 * Prepends the system entries to a host's own — the composition every
 * sealed-realm host wants, since the QuickJS prelude deletes `Date` and
 * `Math.random` on the promise that `sys/now` and `sys/random` exist.
 *
 * @category constructors
 * @since 0.1.0
 */
export const withSystem = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => [...system, ...entries]

/** @category constructors @since 0.1.0 */
export const makeNoop = (): Service => make([])

/** @category layers @since 0.1.0 */
export const layer = (entries: ReadonlyArray<Entry>): Layer.Layer<Catalog> => Layer.succeed(Catalog)(make(entries))

/** @category layers @since 0.1.0 */
export const layerNoop: Layer.Layer<Catalog> = Layer.succeed(Catalog)(makeNoop())
