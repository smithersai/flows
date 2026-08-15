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
import { Effect, Layer, Schema } from "effect"
import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
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
const prelude = (catalog: string): string =>
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
      return bridge(flow, encodeInput(input === undefined ? null : input)).then(function (encoded) {
        var settled = JSON.parse(encoded)
        if (settled.ok) return settled.value
        var error = new Error(settled.message)
        error.name = "FlowCallError"
        throw error
      })
    },
    flows: freeze(${catalog})
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
      tier: projection.tier
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
 * The loaded WebAssembly module, shared by every sandbox in the process.
 *
 * Compiling QuickJS is expensive and the module holds no per-cell state — each
 * evaluation gets its own runtime and context out of it.
 */
let loaded: Promise<QuickJSWASMModule> | undefined

const wasmModule = (): Promise<QuickJSWASMModule> => {
  loaded = loaded ?? newQuickJSWASMModuleFromVariant(variant)
  return loaded
}

const evaluate = (
  module: QuickJSWASMModule,
  evaluation: Sandbox.Evaluation
): Effect.Effect<Cell.Outcome, Sandbox.SandboxError | HarnessError> =>
  Effect.gen(function*() {
    const compiled = Sandbox.compile(evaluation.cell)
    if (compiled instanceof Cell.Rejected) return compiled

    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        if (evaluation.limits?.memoryBytes !== undefined) {
          runtime.setMemoryLimit(evaluation.limits.memoryBytes)
        }
        if (evaluation.limits?.steps !== undefined) {
          const budget = evaluation.limits.steps
          let steps = 0
          runtime.setInterruptHandler(() => ++steps > budget)
        }
        const context: QuickJSContext = runtime.newContext()
        return { runtime, context }
      }),
      ({ context, runtime }) =>
        Effect.sync(() => {
          context.dispose()
          runtime.dispose()
        })
    )
    const { context, runtime } = acquired

    const pending: Array<Sandbox.PendingCall> = []
    let ordinal = 0
    let settled: Cell.Outcome | undefined

    const bridge = context.newFunction("__call", (flowHandle, inputHandle) => {
      const flow = context.getString(flowHandle)
      const encoded = context.getString(inputHandle)
      const deferred = context.newPromise()
      const reply = (payload: unknown): void => {
        const handle = context.newString(JSON.stringify(payload))
        deferred.resolve(handle)
        handle.dispose()
        deferred.dispose()
      }
      pending.push({
        ordinal: ordinal++,
        flow,
        input: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(encoded)),
        settle: (result) =>
          reply(
            result.outcome === "success"
              ? { ok: true, value: result.value ?? null }
              : { ok: false, message: result.message ?? "The flow call failed" }
          ),
        abort: (message) => reply({ ok: false, message })
      })
      return deferred.handle
    })
    context.setProp(context.global, "__call", bridge)
    bridge.dispose()

    const install = context.evalCode(prelude(catalogOf(evaluation.flows)))
    if (install.error !== undefined) {
      const failure = context.dump(install.error)
      install.error.dispose()
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
      handler: evaluation.call,
      limits: evaluation.limits
    })
  }).pipe(Effect.scoped)

/**
 * Constructs the QuickJS sandbox, compiling the WebAssembly module once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Sandbox.Sandbox> = Effect.map(
  Effect.promise(() => wasmModule()),
  (module) =>
    Sandbox.make({
      capabilities: { calls: true, memoryBytes: true, steps: true },
      evaluate: (evaluation) => evaluate(module, evaluation)
    })
)

/**
 * Provides the QuickJS sandbox.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Sandbox.Sandbox> = Layer.effect(Sandbox.Sandbox)(make)
