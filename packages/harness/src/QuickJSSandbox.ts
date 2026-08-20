/**
 * The QuickJS-WASM sandbox binding.
 *
 * This is the production `Sandbox`: the cell runs inside a QuickJS interpreter
 * compiled to WebAssembly, which is a genuinely separate JavaScript realm with
 * no reference to the host's globals, prototypes, or module loader. The same
 * single-file variant runs unmodified on Node and in a browser, so a browser
 * host provides this layer and calls the identical harness.
 *
 * What the cell can reach is exactly `ctx`: `ctx.call` bridges to the host's
 * durable flow boundary, `ctx.flows` is a frozen catalog projection. The
 * prelude removes `Date` and `Math.random` from the realm, because a replayed
 * cell must reach the same calls in the same order. There is no filesystem, no
 * network, no process, and no module loader to reach in the first place.
 *
 * Teardown is scope finalization and cancellation is fiber interruption: an
 * interrupted frame disposes the runtime, which is the only thing holding the
 * cell alive.
 *
 * @since 0.1.0
 */
import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import * as Cell from "./Cell.ts"
import type { HarnessError } from "./HarnessError.ts"
import * as Sandbox from "./Sandbox.ts"

/**
 * The prelude evaluated before every cell.
 *
 * It installs the one binding a cell has and removes the two sources of
 * nondeterminism QuickJS ships with. The raw host bridge is captured in a
 * closure and then deleted from the global object, so a cell cannot reach the
 * unwrapped boundary and hand it unencoded values.
 */
const prelude = (catalog: string, state: string): string =>
  `(function () {
  var bridge = globalThis.__call
  var freeze = function (value) {
    if (value !== null && typeof value === "object") {
      Object.keys(value).forEach(function (key) { freeze(value[key]) })
      Object.freeze(value)
    }
    return value
  }
  var encodeInput = function (input) {
    var seen = []
    var visit = function (value) {
      if (value === null || typeof value === "string" || typeof value === "boolean") return
      if (typeof value === "number" && Number.isFinite(value)) return
      if (typeof value !== "object") throw new TypeError("ctx.call input must be JSON-serializable")
      if (seen.indexOf(value) >= 0) throw new TypeError("ctx.call input must be JSON-serializable")
      var prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("ctx.call input must be JSON-serializable")
      }
      seen.push(value)
      Object.keys(value).forEach(function (key) { visit(value[key]) })
      seen.pop()
    }
    visit(input)
    return JSON.stringify(input)
  }
  delete globalThis.__call
  delete globalThis.Date
  delete Math.random
  globalThis.ctx = Object.freeze({
    call: function (flow, input) {
      if (typeof flow !== "string") return Promise.reject(new TypeError("ctx.call expects a flow name as its first argument"))
      return bridge(flow, encodeInput(input === undefined ? null : input)).then(function (settled) {
        if (settled.ok) return settled.value
        var error = new Error(settled.message)
        error.name = settled.value && settled.value._tag === ${JSON.stringify(Sandbox.callTimeoutTag)}
          ? ${JSON.stringify(Sandbox.callTimeoutErrorName)}
          : "FlowCallError"
        error.value = settled.value
        throw error
      })
    },
    flows: freeze(${catalog}),
    state: freeze(JSON.parse(${state}))
  })
})()`

const wrap = (text: string): string =>
  `globalThis.__cell = (async () => {\n${text}\n})().then(function (value) {
  return JSON.stringify(value === undefined ? null : value)
})`

const catalogOf = (flows: Readonly<Record<string, Cell.FlowProjection>>): string => {
  const entries: Record<string, unknown> = {}
  for (const [name, projection] of Object.entries(flows)) {
    entries[name] = {
      name: projection.name,
      description: projection.description,
      capabilities: [...projection.capabilities],
      tier: projection.tier,
      // The contract tells a cell to read `ctx.flows` before reissuing a
      // rejected call, so the projection has to answer the question the
      // rejection asked: what shape does this flow take?
      ...(Option.isSome(projection.input) ? { input: projection.input.value } : {})
    }
  }
  return JSON.stringify(entries)
}

const raisedFrom = (dumped: unknown): Cell.Raised => {
  if (typeof dumped === "object" && dumped !== null) {
    const record = dumped as { readonly name?: unknown; readonly message?: unknown }
    return new Cell.Raised({
      name: typeof record.name === "string" ? record.name : "Error",
      message: typeof record.message === "string" ? record.message : String(dumped)
    })
  }
  return new Cell.Raised({ name: "Error", message: String(dumped) })
}

/**
 * Builds one owned QuickJS handle from the already-validated JSON result.
 *
 * Materializing the value directly also avoids parsing a multi-megabyte JSON
 * string inside a promise job, which leaves QuickJS 0.32's runtime heap in an
 * uncollectable state during disposal.
 */
const handleFromJson = (
  context: QuickJSContext,
  defineDataProperty: QuickJSHandle,
  value: Schema.Json
): QuickJSHandle => {
  if (value === null) return context.null
  switch (typeof value) {
    case "boolean":
      return value ? context.true : context.false
    case "number":
      return context.newNumber(value)
    case "string":
      return context.newString(value)
  }

  const container = Array.isArray(value) ? context.newArray() : context.newObject()
  try {
    for (const [key, item] of Object.entries(value)) {
      const child = handleFromJson(context, defineDataProperty, item)
      try {
        const property = context.newString(key)
        try {
          context.unwrapResult(
            context.callFunction(defineDataProperty, context.undefined, container, property, child)
          ).dispose()
        } finally {
          property.dispose()
        }
      } finally {
        child.dispose()
      }
    }
    return container
  } catch (error) {
    container.dispose()
    throw error
  }
}

/**
 * Caches only a successful asynchronous load; a rejection may be retried.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheSuccessful = <A>(load: () => Promise<A>): () => Promise<A> => {
  let loaded: Promise<A> | undefined
  return () => {
    if (loaded === undefined) {
      const pending = load()
      loaded = pending
      void pending.catch(() => {
        loaded = undefined
      })
    }
    return loaded
  }
}

const wasmModule = cacheSuccessful(() => newQuickJSWASMModuleFromVariant(variant))

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category models
 * @since 0.1.0
 */
export interface ComputeClockService {
  readonly now: () => number
}

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category services
 * @since 0.1.0
 */
export class ComputeClock extends Context.Service<ComputeClock, ComputeClockService>()(
  "flows/harness/QuickJSSandbox/ComputeClock"
) {}

/**
 * Provides the browser-safe host clock behind the QuickJS clock seam.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerClockLive: Layer.Layer<ComputeClock> = Layer.succeed(ComputeClock)({ now: () => Date.now() })

const capabilities: Sandbox.Capabilities = {
  calls: true,
  memoryBytes: true,
  steps: true,
  timeMs: true
}

const timeLimitExceeded = (timeMs: number): Cell.Rejected =>
  new Cell.Rejected({
    code: "limit_exceeded",
    message: `This cell exceeded its wall-clock limit of ${timeMs} milliseconds`
  })

/**
 * The whole-evaluation ceiling for one call.
 *
 * `Sandbox.make` runs `Sandbox.withDefaults` over the caller's limits before it
 * reaches this binding, and `totalMs` is filled whenever the `timeMs`
 * capability is declared, which this binding declares.
 */
const totalMsOf = (evaluation: Sandbox.Evaluation): number => {
  /* v8 ignore next -- see above: the ceiling always arrives filled, so neither the optional chain nor the coalesce takes its fallback; both only discharge optional types */
  return evaluation.limits?.totalMs ?? Sandbox.defaultLimits.totalMs
}

const evaluate = (
  module: QuickJSWASMModule,
  evaluation: Sandbox.Evaluation,
  clock: ComputeClockService
): Effect.Effect<Cell.Outcome, Sandbox.SandboxError | HarnessError> =>
  Effect.gen(function*() {
    const compiled = Sandbox.compile(evaluation.cell)
    if (compiled instanceof Cell.Rejected) return compiled

    const limits = Sandbox.withDefaults(capabilities, evaluation.limits)
    /* v8 ignore next -- `withDefaults` fills `timeMs` from `defaultLimits` whenever the `timeMs` capability is declared, and this binding declares it, so the coalesce never reaches its fallback; it only discharges the optional type on `Sandbox.Limits` */
    const timeMs = limits.timeMs ?? Sandbox.defaultLimits.timeMs
    // The compute clock's baseline. Host calls shift it forward by their own
    // duration when they settle, so `timeMs` charges the cell for its
    // JavaScript alone: a cell that awaits a ten-minute test run resumes with
    // the budget it suspended with. Without the shift, the first interrupt
    // check after a long `ctx.call` read the whole call as elapsed compute
    // and rejected the frame — which taught agents that verifying their work
    // was fatal.
    let clockBase = clock.now()
    let exhausted: Cell.Rejected | undefined

    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        /* v8 ignore else -- `withDefaults` fills `memoryBytes` from `defaultLimits` whenever the `memoryBytes` capability is declared, and this binding declares it, so the heap ceiling is always set */
        if (limits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(limits.memoryBytes)
        }
        const stepBudget = limits.steps
        let steps = 0
        runtime.setInterruptHandler(() => {
          if (clock.now() - clockBase >= timeMs) {
            exhausted = exhausted ?? timeLimitExceeded(timeMs)
            return true
          }
          if (stepBudget !== undefined && ++steps > stepBudget) {
            exhausted = exhausted ?? new Cell.Rejected({
              code: "limit_exceeded",
              message: `This cell exceeded its limit of ${stepBudget} interpreter steps`
            })
            return true
          }
          return false
        })
        const context: QuickJSContext = runtime.newContext()
        try {
          // Capture the pristine intrinsic before cell code can replace it.
          // Assignment can invoke a hostile inherited setter, while
          // QuickJSContext.defineProp cannot create a writable data property.
          const defineDataProperty = context.unwrapResult(context.evalCode(
            `(function (defineProperty) {
  return function (object, key, value) {
    defineProperty(object, key, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  }
})(Object.defineProperty)`
          ))
          return { runtime, context, defineDataProperty }
        } catch (error) {
          context.dispose()
          runtime.dispose()
          throw error
        }
      }),
      ({ context, defineDataProperty, runtime }) =>
        Effect.sync(() => {
          defineDataProperty.dispose()
          context.dispose()
          runtime.dispose()
        })
    )
    const { context, defineDataProperty, runtime } = acquired

    const pending: Array<Sandbox.PendingCall> = []
    let ordinal = 0
    let settled: Cell.Outcome | undefined

    const bridge = context.newFunction("__call", (flowHandle, inputHandle) => {
      const flow = context.getString(flowHandle)
      const encoded = context.getString(inputHandle)
      const deferred = context.newPromise()
      const reply = (payload: Schema.Json): void => {
        const handle = handleFromJson(context, defineDataProperty, payload)
        try {
          deferred.resolve(handle)
        } finally {
          handle.dispose()
          deferred.dispose()
        }
      }
      pending.push({
        ordinal: ordinal++,
        flow,
        input: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(encoded)),
        settle: (result) =>
          reply(
            result.outcome === "success"
              ? { ok: true, value: result.value ?? null }
              : {
                ok: false,
                message: result.message ?? "The flow call failed",
                value: result.value
              }
          ),
        abort: (message) => reply({ ok: false, message, value: null })
      })
      return deferred.handle
    })
    context.setProp(context.global, "__call", bridge)
    bridge.dispose()

    const install = context.evalCode(
      // The state rides as a doubly-encoded JSON string literal so hostile
      // content can never escape into the prelude's source.
      prelude(catalogOf(evaluation.flows), JSON.stringify(JSON.stringify(evaluation.state ?? null)))
    )
    if (install.error !== undefined) {
      const failure = context.dump(install.error)
      install.error.dispose()
      if (exhausted !== undefined) return exhausted
      return yield* new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: failure
      })
    }
    install.value.dispose()

    const started = context.evalCode(wrap(compiled))
    if (started.error !== undefined) {
      const failure = context.dump(started.error)
      started.error.dispose()
      if (exhausted !== undefined) return exhausted
      return new Cell.Rejected({
        code: "compile_failed",
        message: `The cell did not compile: ${
          typeof failure === "object" && failure !== null && "message" in failure
            ? String((failure as { readonly message: unknown }).message)
            : String(failure)
        }`
      })
    }
    started.value.dispose()

    const cellHandle = context.getProp(context.global, "__cell")
    yield* Effect.addFinalizer(() => Effect.sync(() => cellHandle.dispose()))

    /** Runs every queued VM job, then reads the cell promise. */
    const poll = (): void => {
      runtime.executePendingJobs()
      if (exhausted !== undefined) {
        // An interrupted job leaves the promise pending, so the ceiling ends
        // the evaluation rather than waiting for a settlement that cannot run.
        settled = exhausted
        return
      }
      const state = context.getPromiseState(cellHandle)
      if (state.type === "pending") return
      if (state.type === "fulfilled") {
        const value = context.dump(state.value)
        state.value.dispose()
        settled = typeof value === "string"
          ? Cell.transition(JSON.parse(value))
          : new Cell.Rejected({
            code: "invalid_transition",
            message: "The cell returned a value that is not JSON-serializable."
          })
        return
      }
      const error = context.dump(state.error)
      state.error.dispose()
      settled = raisedFrom(error)
    }

    return yield* Sandbox.driveCell({
      pending,
      flush: () => poll(),
      finished: () => {
        poll()
        if (settled !== undefined) return settled
        if (pending.length > 0) return undefined
        // Nothing is queued and no job can advance the cell: it awaited
        // something the realm can never settle.
        return new Cell.Rejected({
          code: "stalled",
          message:
            "The cell awaited something that never settles. Inside a cell the only thing worth awaiting is ctx.call."
        })
      },
      wait: Effect.void,
      abort: () => {
        for (const call of pending.splice(0)) call.abort("The cell was interrupted")
      },
      // Timed so the host call's duration is refunded to the compute clock.
      handler: (call) =>
        Effect.suspend(() => {
          const pausedAt = clock.now()
          return evaluation.call(call).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                clockBase += clock.now() - pausedAt
              })
            )
          )
        }),
      limits
    })
  }).pipe(
    Effect.scoped,
    // The whole-evaluation backstop, host calls included. `timeMs` is
    // enforced by the interrupt handler above; this ceiling only exists so a
    // host call that never settles cannot hold the frame forever.
    Effect.timeoutOrElse({
      duration: totalMsOf(evaluation),
      orElse: () => Effect.succeed(timeLimitExceeded(totalMsOf(evaluation)))
    })
  )

/**
 * Loads a QuickJS module through the sandbox's typed failure boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadModule = (
  loader: () => Promise<QuickJSWASMModule>
): Effect.Effect<QuickJSWASMModule, Sandbox.SandboxError> =>
  Effect.tryPromise({
    try: loader,
    catch: (cause) =>
      new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "QuickJS WebAssembly module could not be loaded",
        cause
      })
  })

/**
 * Constructs the QuickJS sandbox, compiling the WebAssembly module once.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeWithClock: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock> = Effect.gen(
  function*() {
    const clock = yield* ComputeClock
    const module = yield* loadModule(wasmModule)
    return Sandbox.make({
      capabilities,
      evaluate: (evaluation) => evaluate(module, evaluation, clock)
    })
  }
)

/**
 * Constructs the QuickJS sandbox with the live clock layer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError> = makeWithClock.pipe(
  Effect.provide(layerClockLive)
)

/**
 * Provides the QuickJS sandbox.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Sandbox.Sandbox, Sandbox.SandboxError> = Layer.effect(Sandbox.Sandbox)(make)
