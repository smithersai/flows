/**
 * The deterministic script sandbox port.
 *
 * A cell is arbitrary agent-authored JavaScript, so it never runs in the host
 * realm. It runs behind this port, which grants exactly one effectful
 * primitive — flow invocation against the capability-narrowed catalog the frame
 * was given — and returns a serializable {@link Cell.Outcome}.
 *
 * Two bindings ship: {@link layerRestricted}, a dependency-free deterministic
 * binding used by tests and by hosts that only need identifier-level denial,
 * and `QuickJSSandbox`, the QuickJS-WASM binding that isolates a real separate
 * realm in both Node and browsers.
 *
 * Cancellation is fiber interruption and teardown is scope finalization; a
 * sandbox never installs a host abort signal.
 *
 * @since 0.1.0
 */
import { Context, Effect, Exit, Layer, Schema } from "effect"
import ts from "typescript"
import * as Cell from "./Cell.ts"
import type { HarnessError } from "./HarnessError.ts"

/**
 * Stable failures raised by a sandbox binding itself, as opposed to failures
 * of the cell it was asked to run.
 *
 * A cell that throws is a {@link Cell.Raised} outcome, not a sandbox error.
 * These codes describe the sandbox being unable to do its job at all.
 *
 * @category models
 * @since 0.1.0
 */
export const SandboxErrorCode = Schema.Literals([
  "unavailable",
  "unsupported",
  "runtime_failed"
])

/**
 * Stable failures raised by a sandbox binding itself.
 *
 * @category models
 * @since 0.1.0
 */
export type SandboxErrorCode = typeof SandboxErrorCode.Type

/**
 * A failure of the sandbox binding.
 *
 * @category errors
 * @since 0.1.0
 */
export class SandboxError extends Schema.TaggedError<SandboxError>()("flows/harness/SandboxError", {
  code: SandboxErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * One flow invocation requested from inside a running cell.
 *
 * `ordinal` is the zero-based execution order of the call within the cell. It
 * is the replay anchor: re-executing the same source reaches the same ordinal
 * with the same declaration, which is what lets a settled boundary replay
 * instead of re-running.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invocation {
  readonly ordinal: number
  readonly flow: string
  readonly input: Schema.Json
}

/**
 * Resolves one invocation on behalf of a running cell.
 *
 * A {@link Cell.CallResult} of `failure` is returned to the cell as a catchable
 * exception. Anything the cell must not observe — a permission park, an abort,
 * an engine failure — travels in the error channel and tears the cell down.
 *
 * @category models
 * @since 0.1.0
 */
export type Handler = (
  invocation: Invocation
) => Effect.Effect<Cell.CallResult, HarnessError>

/**
 * Explicitly declared execution limits.
 *
 * Every limit is opt-in. A binding that cannot honour a requested limit fails
 * with `unsupported` rather than silently ignoring it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Limits {
  /** Maximum number of flow calls one cell may make. */
  readonly calls?: number | undefined
  /** Maximum sandbox heap, in bytes. */
  readonly memoryBytes?: number | undefined
  /** Maximum interpreter steps before the cell is stopped. */
  readonly steps?: number | undefined
}

/**
 * Which limits a binding can actually enforce.
 *
 * @category models
 * @since 0.1.0
 */
export interface Capabilities {
  readonly calls: boolean
  readonly memoryBytes: boolean
  readonly steps: boolean
}

/**
 * One cell evaluation request.
 *
 * @category models
 * @since 0.1.0
 */
export interface Evaluation {
  readonly cell: Cell.Source
  readonly flows: Readonly<Record<string, Cell.FlowProjection>>
  readonly call: Handler
  readonly limits?: Limits | undefined
}

/**
 * The deterministic script sandbox.
 *
 * @category services
 * @since 0.1.0
 */
export interface Sandbox {
  readonly capabilities: Capabilities
  readonly evaluate: (
    evaluation: Evaluation
  ) => Effect.Effect<Cell.Outcome, SandboxError | HarnessError>
}

/**
 * Context service for the selected sandbox binding.
 *
 * @category services
 * @since 0.1.0
 */
export const Sandbox: Context.Service<Sandbox, Sandbox> = Context.Service("/harness/Sandbox")

/**
 * Constructs a sandbox from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Sandbox): Sandbox => Sandbox.of(implementation)

/**
 * Provides a sandbox implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: Sandbox): Layer.Layer<Sandbox> => Layer.succeed(Sandbox)(make(implementation))

/**
 * Constructs an unavailable sandbox stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Sandbox> = {}): Sandbox =>
  Sandbox.of({
    capabilities: { calls: false, memoryBytes: false, steps: false },
    evaluate: () =>
      Effect.fail(
        new SandboxError({
          code: "unavailable",
          message: "No sandbox implementation is configured"
        })
      ),
    ...overrides
  })

/**
 * Provides an unavailable sandbox stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Sandbox> = {}): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox)(makeNoop(overrides))

/**
 * Rejects an unsupported limit rather than pretending to honour it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const unsupportedLimit = (limit: string): SandboxError =>
  new SandboxError({
    code: "unsupported",
    message: `This sandbox cannot enforce the ${limit} limit; remove it or select a binding that can`
  })

/**
 * A queued call awaiting resolution by the driver.
 *
 * @internal
 */
interface Pending {
  readonly ordinal: number
  readonly flow: string
  readonly input: Schema.Json
  readonly settle: (result: Cell.CallResult) => void
  readonly abort: (message: string) => void
}

/**
 * The state a binding's driver loop observes.
 *
 * Bindings differ only in how a cell is compiled and how its promises are
 * settled; the interleaving of "drain queued calls, then wait" is identical,
 * so it lives here once.
 *
 * @internal
 */
interface Pump {
  readonly pending: Array<Pending>
  /** Called after each resolved call so a binding may flush its job queue. */
  readonly flush: () => void
  readonly finished: () => Cell.Outcome | undefined
  readonly wait: Effect.Effect<void>
  readonly abort: (message: string) => void
}

/**
 * Runs the shared drive loop: settle queued calls one at a time, in the order
 * the cell issued them, until the cell settles.
 *
 * One at a time is deliberate. Data-dependent calls are the normal case, and a
 * deterministic execution ordinal is what makes a mid-cell crash replayable.
 *
 * @internal
 */
const drive = (
  pump: Pump,
  handler: Handler,
  limits: Limits | undefined
): Effect.Effect<Cell.Outcome, SandboxError | HarnessError> =>
  Effect.gen(function*() {
    let calls = 0
    for (;;) {
      const next = pump.pending.shift()
      if (next !== undefined) {
        if (limits?.calls !== undefined && calls >= limits.calls) {
          const message = `This cell exceeded its limit of ${limits.calls} flow calls`
          next.abort(message)
          pump.abort(message)
          pump.flush()
          return new Cell.Rejected({ code: "limit_exceeded", message })
        }
        calls = calls + 1
        const result = yield* handler({
          ordinal: next.ordinal,
          flow: next.flow,
          input: next.input
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                // `next` was shifted out of `pending` before the handler ran.
                // Settle that active bridge as well as calls queued behind it,
                // then flush the VM so a scoped runtime has no live promise
                // handles when a permission park or engine failure unwinds it.
                next.abort("The cell was interrupted")
                pump.abort("The cell was interrupted")
                pump.flush()
              })
          )
        )
        next.settle(result)
        pump.flush()
        continue
      }
      const outcome = pump.finished()
      if (outcome !== undefined) return outcome
      yield* pump.wait
    }
  })

const makeLatch = (): Latch => {
  let notify: (() => void) | undefined
  return {
    wake: () => {
      const resume = notify
      notify = undefined
      resume?.()
    },
    wait: Effect.callback<void>((resume) => {
      notify = () => resume(Effect.void)
    })
  }
}

/**
 * The bindings every cell may reference, with every nondeterministic and
 * ambient-authority global deliberately absent.
 *
 * `Date` and `Math.random` are omitted because a replayed cell must produce the
 * same calls in the same order. Everything host-shaped — `fetch`,
 * `globalThis`, `process`, `require`, `WebAssembly` — is omitted because the
 * cell's only authority is `ctx.call`.
 *
 * @internal
 */
const deterministicMath: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((name) => name !== "random")
      .map((name) => [name, Math[name as keyof Math]])
  )
)

const allowedGlobals: Readonly<Record<string, unknown>> = Object.freeze({
  Array,
  ArrayBuffer,
  BigInt,
  Boolean,
  DataView,
  Error,
  EvalError,
  Infinity,
  JSON,
  Map,
  Math: deterministicMath,
  NaN,
  Number,
  Object,
  Promise,
  RangeError,
  ReferenceError,
  RegExp,
  Set,
  String,
  Symbol,
  SyntaxError,
  TypeError,
  URIError,
  WeakMap,
  WeakSet,
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
  isFinite,
  isNaN,
  parseFloat,
  parseInt,
  undefined
})

/**
 * The receiver a cell body is invoked with, so `this` reaches nothing.
 *
 * @internal
 */
const hostless: object = Object.freeze(Object.create(null) as object)

const denied = (name: string): never => {
  throw new ReferenceError(
    `${name} is not available inside a cell. The only binding is ctx; every effect is a flow call through ctx.call.`
  )
}

const nonErasableSyntax = (source: ts.SourceFile): string | undefined => {
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isEnumDeclaration(node)) found = "enum declarations"
    else if (ts.isModuleDeclaration(node)) found = "namespace/module declarations"
    else if (ts.isImportEqualsDeclaration(node)) found = "import-equals declarations"
    else if (ts.isExportAssignment(node)) found = "export assignments"
    else if (
      ts.isParameter(node) &&
      node.modifiers?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
          modifier.kind === ts.SyntaxKind.OverrideKeyword
        ) === true
    ) found = "parameter properties"
    else ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Erases type-only syntax from a cell without evaluating or resolving modules.
 *
 * Only Node's strip-safe TypeScript subset is accepted. Constructs that need
 * JavaScript emit are refused instead of being silently transformed into new
 * runtime behaviour.
 *
 * @category conversions
 * @since 0.1.0
 */
export const compile = (cell: Cell.Source): string | Cell.Rejected => {
  if (cell.language === "javascript") return cell.text
  const parsed = ts.createSourceFile("cell.ts", cell.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const forbidden = nonErasableSyntax(parsed)
  if (forbidden !== undefined) {
    return new Cell.Rejected({
      code: "compile_failed",
      message: `The TypeScript cell uses ${forbidden}, which are not erasable syntax.`
    })
  }
  const transpiled = ts.transpileModule(cell.text, {
    compilerOptions: {
      erasableSyntaxOnly: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true
    },
    fileName: "cell.ts",
    reportDiagnostics: true
  })
  const diagnostic = transpiled.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error)
  if (diagnostic !== undefined) {
    return new Cell.Rejected({
      code: "compile_failed",
      message: `The TypeScript cell did not compile: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
    })
  }
  return transpiled.outputText
}

/**
 * Builds the frozen `ctx` binding handed to one cell.
 *
 * @internal
 */
const makeContext = (
  flows: Readonly<Record<string, Cell.FlowProjection>>,
  enqueue: (flow: string, input: Schema.Json) => Promise<unknown>
): Readonly<Record<string, unknown>> => {
  const catalog: Record<string, unknown> = {}
  for (const [name, projection] of Object.entries(flows)) {
    catalog[name] = Object.freeze({
      name: projection.name,
      description: projection.description,
      capabilities: Object.freeze([...projection.capabilities]),
      tier: projection.tier
    })
  }
  return Object.freeze({
    call: (flow: unknown, input: unknown): Promise<unknown> => {
      if (typeof flow !== "string") {
        return Promise.reject(new TypeError("ctx.call expects a flow name as its first argument"))
      }
      const decoded = Schema.decodeUnknownResult(Schema.Json)(input ?? null)
      return decoded._tag === "Failure"
        ? Promise.reject(new TypeError("ctx.call input must be JSON-serializable"))
        : enqueue(flow, decoded.success)
    },
    flows: Object.freeze(catalog)
  })
}

/**
 * The failure a cell threw, projected into stable serializable text.
 *
 * @internal
 */
const raised = (error: unknown): Cell.Raised => {
  if (error instanceof Error) {
    return new Cell.Raised({ name: error.name, message: error.message })
  }
  return new Cell.Raised({ name: "Error", message: String(error) })
}

/**
 * A flow failure, as the exception the cell observes.
 *
 * @internal
 */
const callFailure = (result: Cell.CallResult): Error => {
  const error = new Error(result.message ?? "The flow call failed")
  error.name = "FlowCallError"
  return error
}

/**
 * Constructs the dependency-free deterministic sandbox.
 *
 * The cell is compiled into an async function whose entire scope is a proxy
 * that resolves only {@link allowedGlobals} and `ctx`; every other identifier
 * throws a `ReferenceError` at the point of use. That denies ambient time,
 * randomness, network, filesystem, process, and module access by identifier,
 * which is exactly what the deterministic contract needs and all a
 * same-realm binding can honestly claim.
 *
 * A `with` block only works in sloppy mode, and a sloppy-mode function called
 * without a receiver binds `this` to the host's `globalThis` — which would hand
 * every cell `this.process` for free, past the scope proxy entirely. The cell
 * body is therefore a plain async function invoked with an explicit
 * null-prototype receiver, so `this` denies the same things every identifier
 * does.
 *
 * It is *not* an isolation boundary: same-realm JavaScript can still reach the
 * host `Function` constructor through a prototype chain. Hosts that execute
 * untrusted cells use the QuickJS binding, which is a separate realm.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeRestricted = (): Sandbox =>
  Sandbox.of({
    capabilities: { calls: true, memoryBytes: false, steps: false },
    evaluate: (evaluation) =>
      Effect.gen(function*() {
        if (evaluation.limits?.memoryBytes !== undefined) return yield* unsupportedLimit("memory")
        if (evaluation.limits?.steps !== undefined) return yield* unsupportedLimit("step")
        const compiled = compile(evaluation.cell)
        if (compiled instanceof Cell.Rejected) return compiled

        const latch = makeLatch()
        const pending: Array<Pending> = []
        let ordinal = 0
        let aborted: string | undefined
        let settled: Cell.Outcome | undefined

        const enqueue = (flow: string, input: Schema.Json): Promise<unknown> => {
          if (aborted !== undefined) return Promise.reject(new Error(aborted))
          return new Promise<unknown>((resolve, reject) => {
            pending.push({
              ordinal: ordinal++,
              flow,
              input,
              settle: (result) => result.outcome === "success" ? resolve(result.value) : reject(callFailure(result)),
              abort: (message) => reject(new Error(message))
            })
            latch.wake()
          })
        }

        const context = makeContext(evaluation.flows, enqueue)
        const scope = new Proxy({}, {
          has: () => true,
          get: (_target, property) => {
            if (property === Symbol.unscopables) return undefined
            if (typeof property !== "string") return undefined
            if (property === "ctx") return context
            if (Object.hasOwn(allowedGlobals, property)) return allowedGlobals[property]
            return denied(property)
          },
          set: (_target, property) => denied(String(property))
        })

        let cell: (scope: object, receiver: object) => Promise<unknown>
        try {
          // The cell is agent source; the scope proxy is the only binding it has.
          cell = new Function(
            "__scope",
            "__this",
            `return (async function () { with (__scope) {\n${compiled}\n} }).call(__this)`
          ) as (scope: object, receiver: object) => Promise<unknown>
        } catch (cause) {
          return new Cell.Rejected({
            code: "compile_failed",
            message: `The cell did not compile: ${cause instanceof Error ? cause.message : String(cause)}`
          })
        }

        yield* Effect.sync(() => {
          let started: Promise<unknown>
          try {
            started = cell(scope, hostless)
          } catch (cause) {
            settled = raised(cause)
            latch.wake()
            return
          }
          started.then(
            (value) => {
              settled = Cell.transition(value)
              latch.wake()
            },
            (cause) => {
              settled = raised(cause)
              latch.wake()
            }
          )
        })

        return yield* drive(
          {
            pending,
            flush: () => {},
            finished: () => settled,
            wait: latch.wait,
            abort: (message) => {
              aborted = message
              for (const item of pending.splice(0)) item.abort(message)
            }
          },
          evaluation.call,
          evaluation.limits
        )
      })
  })

/**
 * Provides the dependency-free deterministic sandbox.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerRestricted: Layer.Layer<Sandbox> = Layer.sync(Sandbox)(() => makeRestricted())

/**
 * A queued call awaiting resolution by a binding's driver.
 *
 * @category models
 * @since 0.1.0
 */
export type PendingCall = Pending

/**
 * A wake-up latch shared between a binding's driver loop and its cell.
 *
 * @category models
 * @since 0.1.0
 */
export interface Latch {
  readonly wake: () => void
  readonly wait: Effect.Effect<void>
}

/**
 * Creates the wake-up latch a binding's driver waits on.
 *
 * @category constructors
 * @since 0.1.0
 */
export const latch = (): Latch => makeLatch()

/**
 * Drives one externally compiled cell to settlement.
 *
 * Exposed so a separate-realm binding reuses the exact interleaving the
 * restricted binding uses — settle queued calls one at a time, in issue order,
 * until the cell settles — instead of reimplementing it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const driveCell = (options: {
  readonly pending: Array<Pending>
  readonly flush: () => void
  readonly finished: () => Cell.Outcome | undefined
  readonly wait: Effect.Effect<void>
  readonly abort: (message: string) => void
  readonly handler: Handler
  readonly limits?: Limits | undefined
}): Effect.Effect<Cell.Outcome, SandboxError | HarnessError> =>
  drive(
    {
      pending: options.pending,
      flush: options.flush,
      finished: options.finished,
      wait: options.wait,
      abort: options.abort
    },
    options.handler,
    options.limits
  )

/**
 * Projects a thrown value into a stable serializable cell outcome.
 *
 * @category conversions
 * @since 0.1.0
 */
export const raisedOutcome = (error: unknown): Cell.Raised => raised(error)

/**
 * The exception a cell observes when a flow call fails.
 *
 * @category conversions
 * @since 0.1.0
 */
export const failureError = (result: Cell.CallResult): Error => callFailure(result)
