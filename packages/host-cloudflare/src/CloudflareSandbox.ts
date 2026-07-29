import * as RemoteSandbox from "@flows/host/RemoteSandbox"
import type * as Shell from "@flows/host/Shell"
import { Effect, Layer, Stream } from "effect"

/**
 * The provider is deliberately injected so this package has no ambient Worker
 * binding or live network dependency. An adapter around `@cloudflare/sandbox`
 * supplies this service in a Worker entrypoint.
 *
 * @category models
 * @since 0.1.0
 */
export type SandboxProvider = RemoteSandbox.Provider

/** Provider-neutral Cloudflare Sandbox client surface. @category models @since 0.1.0 */
export interface Client {
  readonly exec: (
    command: string,
    options?: {
      readonly cwd?: string
      readonly env?: Record<string, string>
      readonly timeout?: number
    }
  ) => Promise<Shell.ShellResult>
  readonly execStream: (
    command: string,
    options?: {
      readonly cwd?: string
      readonly env?: Record<string, string>
      readonly timeout?: number
    }
  ) => Promise<ReadableStream<Uint8Array>>
  readonly destroy: () => Promise<void>
}

const providerError = (method: string, cause: unknown): RemoteSandbox.ProviderError =>
  new RemoteSandbox.ProviderError({
    code: "spawn_error",
    message: `Cloudflare Sandbox ${method} failed`,
    cause
  })

/**
 * Adapts a Cloudflare Sandbox client factory to the shared provider.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromBinding = (
  open: (session: string) => Client,
  session = "flows"
): SandboxProvider => {
  let sandbox: Client | undefined
  const execOptions = (options: Shell.ShellOptions | undefined) => ({
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.env === undefined ? {} : { env: { ...options.env } }),
    ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
  })

  return RemoteSandbox.Provider.of({
    session,
    open: Effect.fn("CloudflareSandbox.open")((requested) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          sandbox = open(requested)
        }),
        () =>
          sandbox === undefined
            ? Effect.void
            : Effect.tryPromise({
              try: () => sandbox!.destroy(),
              catch: (cause) => providerError("destroy", cause)
            }).pipe(Effect.ignore)
      )
    ),
    exec: Effect.fn("CloudflareSandbox.exec")((command, options) =>
      sandbox === undefined
        ? Effect.fail(providerError("exec", new Error("sandbox is not open")))
        : options?.stdin !== undefined
        ? Effect.fail(providerError("exec", new Error("Cloudflare Sandbox does not expose command stdin")))
        : Effect.tryPromise({
          try: () => sandbox!.exec(command, execOptions(options)),
          catch: (cause) => providerError("exec", cause)
        }).pipe(
          Effect.map((result) => ({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
          }))
        )
    ),
    execStream: (command, options) =>
      sandbox === undefined
        ? Stream.fail(providerError("execStream", new Error("sandbox is not open")))
        : options?.stdin !== undefined
        ? Stream.fail(providerError("execStream", new Error("Cloudflare Sandbox does not expose command stdin")))
        : Stream.unwrap(
          Effect.fn("CloudflareSandbox.execStream")(() =>
            Effect.tryPromise({
              try: () => sandbox!.execStream(command, execOptions(options)),
              catch: (cause) => providerError("execStream", cause)
            }).pipe(
              Effect.map((body) =>
                Stream.fromReadableStream({
                  evaluate: () => body,
                  onError: (cause) => providerError("execStream", cause)
                }).pipe(
                  Stream.map((chunk): Shell.ShellChunk => ({ kind: "stdout", chunk }))
                )
              )
            )
          )()
        )
  })
}

/** Provides the provider-neutral remote sandbox service. @category layers @since 0.1.0 */
export const layer = (provider: SandboxProvider): Layer.Layer<RemoteSandbox.Provider> =>
  Layer.succeed(RemoteSandbox.Provider)(provider)

/** Replaces the local unavailable shell with the remote sandbox shell. @category layers @since 0.1.0 */
export const layerShell = (provider: SandboxProvider): Layer.Layer<Shell.Shell> => RemoteSandbox.layerShell(provider)
