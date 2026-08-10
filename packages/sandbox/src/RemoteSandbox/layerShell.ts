/**
 * Adapts a remote sandbox provider to the Host Shell service.
 *
 * @since 0.1.0
 */
import { ShellError } from "@smthrs/host/HostError"
import { Shell } from "@smthrs/host/Shell"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type { Provider } from "./Provider.ts"
import type { ProviderError } from "./ProviderError.ts"

/**
 * Converts a provider failure to the stable Host Shell failure surface.
 *
 * @private
 * @since 0.1.0
 */
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
 * or stream consumer closes that scope and runs the finalizer installed by
 * `Provider.open`.
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
