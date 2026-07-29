/**
 * Vercel Sandbox binding for the host's provider-neutral remote sandbox seam.
 *
 * The Vercel SDK is intentionally not imported here: applications construct a
 * provider with their Vercel Sandbox client and pass it to `layerWithSandbox`.
 * This keeps the edge root browser-safe while preserving the exact
 * `RemoteSandbox.Provider` seam owned by `@flows/host`.
 *
 * @since 0.1.0
 */
import * as RemoteSandbox from "@flows/host/RemoteSandbox"
import type { Shell, ShellChunk, ShellOptions, ShellResult } from "@flows/host/Shell"
import type { Sandbox } from "@vercel/sandbox"
import { Effect, Stream } from "effect"
import type { Layer } from "effect"

/** A provider supplied by an adapter around `@vercel/sandbox`. @category models */
export type Provider = RemoteSandbox.Provider

/** The provider-neutral subset exposed by a Vercel Sandbox session. @category models */
export interface Session {
  readonly exec: (command: string, options?: ShellOptions) => Promise<ShellResult>
  readonly execStream: (command: string, options?: ShellOptions) => AsyncIterable<ShellChunk>
  readonly close: () => Promise<void>
}

/** Structural adapter boundary for `@vercel/sandbox`. @category models */
export interface Binding {
  readonly open: (session: string) => Promise<Session>
}

const providerError = (message: string, cause: unknown): RemoteSandbox.ProviderError =>
  new RemoteSandbox.ProviderError({ code: "spawn_error", message, cause })

/** Adapts a Vercel Sandbox client to the shared scoped provider contract. @category constructors @since 0.1.0 */
export const fromBinding = (binding: Binding, session = "flows"): Provider => {
  let opened: Session | undefined
  return RemoteSandbox.Provider.of({
    session,
    open: Effect.fn("VercelSandbox.open")((requested) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            opened = await binding.open(requested)
          },
          catch: (cause) => providerError("Vercel Sandbox open failed", cause)
        }),
        () =>
          opened === undefined
            ? Effect.void
            : Effect.tryPromise({
              try: () => opened!.close(),
              catch: (cause) => providerError("Vercel Sandbox close failed", cause)
            }).pipe(Effect.ignore)
      )
    ),
    exec: Effect.fn("VercelSandbox.exec")((command, options) =>
      opened === undefined
        ? Effect.fail(providerError("Vercel Sandbox is not open", undefined))
        : Effect.tryPromise({
          try: () => opened!.exec(command, options),
          catch: (cause) => providerError("Vercel Sandbox exec failed", cause)
        })
    ),
    execStream: (command, options) =>
      opened === undefined
        ? Stream.fail(providerError("Vercel Sandbox is not open", undefined))
        : Stream.unwrap(
          Effect.fn("VercelSandbox.execStream")(() =>
            Effect.succeed(
              Stream.fromAsyncIterable(
                opened!.execStream(command, options),
                (cause) => providerError("Vercel Sandbox stream failed", cause)
              )
            )
          )()
        )
  })
}

/**
 * Adapts an already-created Vercel Sandbox SDK instance.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromSandbox = (sandbox: Sandbox, session = sandbox.name): Provider =>
  fromBinding({
    open: async () => ({
      exec: async (command, options) => {
        if (options?.stdin !== undefined) {
          throw new Error("Vercel Sandbox does not expose command stdin")
        }
        const result = await sandbox.runCommand({
          cmd: "sh",
          args: ["-lc", command],
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: { ...options.env } }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        })
        return {
          stdout: await result.stdout(),
          stderr: await result.stderr(),
          exitCode: result.exitCode
        }
      },
      execStream: async function*(command, options) {
        if (options?.stdin !== undefined) {
          throw new Error("Vercel Sandbox does not expose command stdin")
        }
        const running = await sandbox.runCommand({
          cmd: "sh",
          args: ["-lc", command],
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: { ...options.env } }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          detached: true
        })
        for await (const line of running.logs()) {
          yield {
            kind: line.stream,
            chunk: new TextEncoder().encode(line.data)
          }
        }
      },
      close: async () => {
        await sandbox.stop()
      }
    })
  }, session)

/**
 * Provides a Shell backed by a scoped Vercel Sandbox provider. The shared seam
 * owns result/error normalization and interruption finalizers.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithSandbox = (provider: Provider): Layer.Layer<Shell> => RemoteSandbox.layerShell(provider)

/**
 * Names the provider binding explicitly at application boundaries.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeProvider = (provider: Provider): Provider => provider
