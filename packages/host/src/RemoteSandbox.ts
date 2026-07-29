/**
 * Provider-neutral remote process execution for serverless Host bundles.
 *
 * Provider packages adapt their SDK sessions to `Provider`; this module owns
 * the conversion to the closed `ShellError` surface. Opening a provider is
 * scoped, so interruption closes the layer scope and runs the provider's
 * cancellation finalizer. No `AbortSignal` crosses this seam.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { ShellError, ShellErrorCode } from "./HostError.ts"
import { Shell } from "./Shell.ts"
import type { ShellChunk, ShellOptions, ShellResult } from "./Shell.ts"

/**
 * A provider failure before it is normalized onto the Host error surface.
 *
 * The code intentionally reuses the closed `ShellErrorCode` schema. Provider
 * packages may add SDK details to `cause`, but cannot create new Host-visible
 * failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()(
  "flows/host/RemoteSandbox/ProviderError",
  {
    code: ShellErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * A configured remote-sandbox provider.
 *
 * `session` is the stable provider-neutral session key. `open(session)` must
 * acquire the remote session and register its cancellation/close operation as
 * a scope finalizer. `exec` and `execStream` operate on that opened session.
 *
 * @category services
 * @since 0.1.0
 */
export interface Provider {
  readonly session: string
  readonly open: (session: string) => Effect.Effect<void, ProviderError, Scope.Scope>
  readonly exec: (
    command: string,
    options?: ShellOptions
  ) => Effect.Effect<ShellResult, ProviderError>
  readonly execStream: (
    command: string,
    options?: ShellOptions
  ) => Stream.Stream<ShellChunk, ProviderError>
}

/**
 * Remote-sandbox provider service tag.
 *
 * Provider packages may expose this tag in addition to passing the configured
 * service directly to `layerShell`.
 *
 * @category services
 * @since 0.1.0
 */
export const Provider: Context.Service<Provider, Provider> = Context.Service(
  "flows/host/RemoteSandbox/Provider"
)

const shellError = (method: string, command: string | undefined) => (error: ProviderError): ShellError =>
  new ShellError({
    code: error.code,
    module: "RemoteSandbox",
    method,
    message: error.message,
    command
  })

/**
 * Adapts a configured provider to the standard `Shell` service.
 *
 * Provider acquisition is tied to the layer scope. Interrupting an execution
 * or stream consumer closes that scope and therefore runs the finalizer
 * installed by `Provider.open`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerShell = (provider: Provider): Layer.Layer<Shell> =>
  Layer.effect(
    Shell,
    provider.open(provider.session).pipe(
      Effect.match({
        onFailure: (error) =>
          Shell.of({
            exec: (command) => Effect.fail(shellError("open", command)(error)),
            stream: (command) => Stream.fail(shellError("open", command)(error))
          }),
        onSuccess: () =>
          Shell.of({
            exec: Effect.fn("RemoteSandbox.Shell.exec")((command, options) =>
              provider.exec(command, options).pipe(
                Effect.mapError(shellError("exec", command))
              )
            ),
            stream: (command, options) =>
              provider.execStream(command, options).pipe(
                Stream.mapError(shellError("execStream", command))
              )
          })
      })
    )
  )

/**
 * One scripted response used by `TestSandbox.make`.
 *
 * `pending` creates an operation that runs until its fiber is interrupted.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestScript {
  readonly result?: ShellResult | undefined
  readonly chunks?: ReadonlyArray<ShellChunk> | undefined
  readonly failure?: ProviderError | undefined
  readonly pending?: boolean | undefined
}

/**
 * Mutable observations exposed by the deterministic test double.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSandboxState {
  readonly openedSessions: Array<string>
  readonly commands: Array<string>
  cancellations: number
}

/**
 * A scripted provider plus its observable cancellation state.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSandboxProvider extends Provider {
  readonly state: TestSandboxState
}

const makeTestSandbox = (options: {
  readonly session?: string | undefined
  readonly scripts?: Readonly<Record<string, TestScript>> | undefined
  readonly openFailure?: ProviderError | undefined
} = {}): TestSandboxProvider => {
  const state: TestSandboxState = {
    openedSessions: [],
    commands: [],
    cancellations: 0
  }

  const script = (command: string): TestScript =>
    options.scripts?.[command] ?? {
      result: { stdout: "", stderr: `command not found: ${command}\n`, exitCode: 127 }
    }

  const exec = Effect.fn("RemoteSandbox.TestSandbox.exec")((command: string) => {
    state.commands.push(command)
    const current = script(command)
    if (current.failure !== undefined) return Effect.fail(current.failure)
    if (current.pending === true) {
      return Effect.never as Effect.Effect<ShellResult, ProviderError>
    }
    return Effect.succeed(
      current.result ?? {
        stdout: "",
        stderr: "",
        exitCode: 0
      }
    )
  })

  const provider: TestSandboxProvider = {
    session: options.session ?? "test-session",
    open: (session) =>
      options.openFailure === undefined
        ? Effect.acquireRelease(
          Effect.sync(() => {
            state.openedSessions.push(session)
          }),
          () =>
            Effect.sync(() => {
              state.cancellations += 1
            })
        )
        : Effect.fail(options.openFailure),
    exec,
    execStream: (command) => {
      state.commands.push(command)
      const current = script(command)
      return current.failure !== undefined
        ? Stream.fail(current.failure)
        : current.pending === true
        ? Stream.never
        : Stream.fromArray(
          current.chunks ??
            [{
              kind: "stdout",
              chunk: new TextEncoder().encode(current.result?.stdout ?? "")
            }]
        )
    },
    state
  }
  return Provider.of(provider) as TestSandboxProvider
}

/**
 * Deterministic scripted provider constructor for adapter and cancellation
 * tests.
 *
 * @category testing
 * @since 0.1.0
 */
export const TestSandbox = {
  make: makeTestSandbox
} as const
