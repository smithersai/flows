/**
 * Browser `Pty` layer.
 *
 * There is no pseudo-terminal in a browser tab: no `openpty`, no child process
 * to attach one to. The service is still present and still fails in the error
 * channel, so a caller sees a typed `PtyError` rather than a missing tag.
 *
 * TICKET: pty-in-browser — see Concepts/Tickets Not Exceptions.md in the spec
 * vault.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Pty, PtyError } from "../Pty.ts"

/**
 * Provides a `Pty` service whose `spawn` fails with `unsupported`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerUnsupported: Layer.Layer<Pty> = Layer.succeed(Pty)({
  spawn: (command) =>
    Effect.fail(
      new PtyError({
        code: "unsupported",
        message: `no pty in the browser (requested: ${command})`
      })
    )
})
