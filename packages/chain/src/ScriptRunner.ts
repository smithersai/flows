/**
 * The script interpreter port, and its in-process implementation.
 *
 * A script's only exits are `ctx.call` and the outcome it returns. Calls are
 * settled one at a time by an Effect handler (the same pump shape the
 * QuickJS sandbox uses), so a hardened interpreter is a later layer swap
 * with no chain change (`docs/specs/Concepts/Chain Slice.md`).
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Schema } from "effect"
import * as Outcome from "./Outcome.ts"
import type * as Script from "./Script.ts"

/** @category errors @since 0.1.0 */
export class ScriptFailure extends Schema.TaggedErrorClass<ScriptFailure>()("/chain/ScriptFailure", {
  code: Schema.Literals(["compile", "runtime", "invalid_outcome", "runner_unavailable"]),
  message: Schema.String
}) {}

/**
 * One call a running script issued; ordinals are assigned by the chain's
 * handler, which owns the per-link call counter.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  readonly name: string
  readonly payload: unknown
}

/** @category services @since 0.1.0 */
export interface Service {
  readonly run: <E>(
    script: Script.Script,
    handler: (request: Request) => Effect.Effect<unknown, E>
  ) => Effect.Effect<Outcome.Outcome, ScriptFailure | E>
}

/** @category services @since 0.1.0 */
export class ScriptRunner extends Context.Service<ScriptRunner, Service>()("/chain/ScriptRunner") {}

/** @category constructors @since 0.1.0 */
export const make = (implementation: Service): Service => ScriptRunner.of(implementation)

/** @category constructors @since 0.1.0 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    run: Effect.fn("ScriptRunner.run")(() =>
      Effect.fail(new ScriptFailure({ code: "runner_unavailable", message: "run is unavailable" }))
    ),
    ...overrides
  })

/** @category layers @since 0.1.0 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ScriptRunner> =>
  Layer.succeed(ScriptRunner)(makeNoop(overrides))

interface Pending {
  readonly name: string
  readonly payload: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

type Settled = { readonly _tag: "value"; readonly value: unknown } | {
  readonly _tag: "thrown"
  readonly error: unknown
}

/**
 * Decodes a script's returned value into an outcome; shared by every
 * runner binding so they reject the same shapes.
 *
 * @category gates
 * @since 0.1.0
 */
export const decodeOutcome = Schema.decodeUnknownOption(Outcome.Outcome)

/**
 * The bridge's strict JSON boundary, shared by every binding: only null,
 * finite numbers, strings, booleans, and acyclic plain objects/arrays
 * cross, and what crosses is a structural copy. Mirrors the check the
 * QuickJS prelude performs in-realm, so both runners refuse the same
 * shapes with the same message.
 *
 * @category gates
 * @since 0.1.0
 */
export const jsonBoundary = (
  value: unknown
): { readonly _tag: "Ok"; readonly value: unknown } | { readonly _tag: "Refused" } => {
  const seen: Array<unknown> = []
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true
    if (typeof candidate === "number") return Number.isFinite(candidate)
    if (typeof candidate !== "object") return false
    if (seen.includes(candidate)) return false
    const prototype = Object.getPrototypeOf(candidate)
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) return false
    seen.push(candidate)
    const ok = Object.keys(candidate as Record<string, unknown>).every((key) =>
      visit((candidate as Record<string, unknown>)[key])
    )
    seen.pop()
    return ok
  }
  const normalized = value === undefined ? null : value
  if (!visit(normalized)) return { _tag: "Refused" }
  return { _tag: "Ok", value: JSON.parse(JSON.stringify(normalized)) }
}

/**
 * Renders a script failure value the way the QuickJS binding renders a
 * dumped realm error, so runtime failure messages match across runners.
 *
 * @category gates
 * @since 0.1.0
 */
export const failureMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error)

const abortError = (): Error => new Error("the link was aborted")

const runInProcess = <E>(
  script: Script.Script,
  handler: (request: Request) => Effect.Effect<unknown, E>
): Effect.Effect<Outcome.Outcome, ScriptFailure | E> =>
  Effect.gen(function*() {
    let factory: (
      ctx: unknown,
      done: typeof Outcome.done,
      to: typeof Outcome.to,
      park: typeof Outcome.park
    ) => unknown
    try {
      // The Function constructor is the point of this layer: an in-process
      // interpreter whose body is the authored script. Sealing beyond the
      // ctx surface is the QuickJS layer's job.

      factory = new Function(
        "ctx",
        "done",
        "to",
        "park",
        `"use strict"\nreturn (async () => {\n${script.text}\n})()`
      ) as typeof factory
    } catch (error) {
      return yield* new ScriptFailure({ code: "compile", message: String(error) })
    }

    const pending: Array<Pending> = []
    let settled: Settled | undefined
    let aborted = false
    let notify: (() => void) | undefined
    const signal = (): void => {
      const wake = notify
      notify = undefined
      if (wake !== undefined) wake()
    }
    const arm = (): Promise<void> =>
      new Promise((resolve) => {
        notify = resolve
      })

    const ctx = Object.freeze({
      call: (name: unknown, payload?: unknown) =>
        new Promise((resolve, reject) => {
          if (aborted) {
            reject(abortError())
            return
          }
          // The same in-realm checks the QuickJS prelude performs: a
          // non-string name and a non-JSON payload reject identically, and
          // the payload crosses as a structural copy.
          if (typeof name !== "string") {
            reject(new TypeError("ctx.call expects a call name as its first argument"))
            return
          }
          const payloadBoundary = jsonBoundary(payload)
          if (payloadBoundary._tag === "Refused") {
            reject(new TypeError("ctx.call input must be JSON-serializable"))
            return
          }
          pending.push({ name, payload: payloadBoundary.value, resolve, reject })
          signal()
        })
    })

    // The factory body is `return (async () => {...})()`, so invoking it
    // never throws synchronously — every script error lands in the rejection.
    Promise.resolve(factory(ctx, Outcome.done, Outcome.to, Outcome.park)).then(
      (value) => {
        settled = { _tag: "value", value }
        signal()
      },
      (error: unknown) => {
        settled = { _tag: "thrown", error }
        signal()
      }
    )

    while (true) {
      const wake = arm()
      const next = pending.shift()
      if (next !== undefined) {
        const result = yield* handler({ name: next.name, payload: next.payload }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // A failed handler aborts the whole run: the script may not
              // catch its way past a gate. Later settlements are ignored.
              aborted = true
              next.reject(abortError())
              for (const stale of pending.splice(0)) stale.reject(abortError())
            })
          )
        )
        // A handler result crosses the same JSON boundary in every
        // binding; a host handler returning something unserializable is a
        // rejected call the script can observe, never a defect.
        const resultBoundary = jsonBoundary(result)
        if (resultBoundary._tag === "Refused") {
          next.reject(new Error(`the "${next.name}" call result is not JSON-serializable`))
        } else {
          next.resolve(resultBoundary.value)
        }
        continue
      }
      if (settled !== undefined) {
        if (settled._tag === "thrown") {
          return yield* new ScriptFailure({ code: "runtime", message: failureMessage(settled.error) })
        }
        const outcome = decodeOutcome(settled.value)
        if (outcome._tag === "None") {
          return yield* new ScriptFailure({
            code: "invalid_outcome",
            message: "the script did not return done(...), to(...), or park(...)"
          })
        }
        return outcome.value
      }
      yield* Effect.promise(() => wake)
    }
  })

/**
 * The in-process runner: the script body runs as a sealed async `Function`
 * with `ctx`, `done`, `to`, and `park` in scope.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInProcess: Layer.Layer<ScriptRunner> = Layer.succeed(ScriptRunner)(
  make({ run: runInProcess })
)
