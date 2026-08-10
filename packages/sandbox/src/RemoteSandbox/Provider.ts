/**
 * Defines the provider-neutral remote sandbox contract.
 *
 * @since 0.1.0
 */
import type { ShellChunk, ShellOptions, ShellResult } from "@smthrs/host/Shell"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { ProviderError } from "./ProviderError.ts"

/**
 * A configured remote-sandbox provider.
 *
 * `session` is the stable provider-neutral session key. `open(session)` must
 * acquire the remote session and register its cancellation or close operation
 * as a scope finalizer. `exec` and `execStream` operate on that opened session.
 *
 * @category services
 * @since 0.1.0
 */
export interface Provider {
  readonly session: string
  readonly open: (session: string) => Effect.Effect<void, ProviderError, Scope>
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
 * @category services
 * @since 0.1.0
 */
export const Provider: Context.Service<Provider, Provider> = Context.Service(
  "flows/host/RemoteSandbox/Provider"
)
