/**
 * Browser `Jj` layer.
 *
 * jj is a native binary. Until it is compiled to wasm there is nothing to run,
 * so every operation reports `not_installed` — the same code the node
 * implementation uses when the binary is absent, which keeps callers from
 * needing a browser-specific branch. The service is still present and still
 * fails in the error channel: an absent capability is a capability with an
 * answer, never a missing tag.
 *
 * TICKET: browser jj (wasm) — see Concepts/Browser jj.md and
 * Concepts/Tickets Not Exceptions.md in the spec vault.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Jj, JjError } from "../Jj.ts"

const fail = (command: string) =>
  Effect.fail(
    new JjError({
      code: "not_installed",
      message: "jj is not available in the browser",
      command
    })
  )

/**
 * Provides a `Jj` service whose every operation fails with `not_installed`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerUnsupported: Layer.Layer<Jj> = Layer.succeed(Jj)({
  snapshot: () => fail("jj commit"),
  restore: () => fail("jj edit"),
  diff: () => fail("jj diff"),
  workspaceAdd: () => fail("jj workspace add"),
  workspaceForget: () => fail("jj workspace forget"),
  status: () => fail("jj status")
})
