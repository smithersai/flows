/**
 * The package barrel plus the two layers that exist only as an answer: Bun's
 * reuse of the Node adapter, and the browser's ticket-failing stub. Neither has
 * behaviour of its own, so the assertions are that they are wired to the thing
 * they claim to be wired to and that they keep the stable identity strings.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as BrowserPty from "../src/browser/BrowserPty.ts"
import * as BunPty from "../src/bun/BunPty.ts"
import * as Index from "../src/index.ts"
import * as NodePty from "../src/node/NodePty.ts"
import { Pty } from "../src/Pty.ts"

describe("@smthrs/pty barrel", () => {
  it("re-exports the contract flat", () => {
    expect(Object.keys(Index).sort()).toEqual(
      ["Pty", "PtyError", "PtyErrorCode", "layerNoop", "make", "makeNoop", "ptyError"].sort()
    )
  })

  /**
   * The tag key is digested into step keys and the error `_tag` round-trips
   * through the journal, so moving these modules out of `@smthrs/host` must not
   * rename either.
   */
  it("keeps the `flows/host/…` identity strings the step-key digest depends on", () => {
    expect(Pty.key).toBe("flows/host/Pty")
    expect(new Index.PtyError({ code: "unknown", message: "x" })._tag).toBe("flows/host/PtyError")
  })
})

describe("BunPty", () => {
  it("reuses the Node adapter rather than shipping a second implementation", () => {
    expect(BunPty.layer).toBe(NodePty.layer)
  })
})

describe("BrowserPty", () => {
  it("reports `unsupported` for `spawn`, echoing the requested command", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.flatMap(Pty, (pty) => pty.spawn("bash", { cols: 80, rows: 24 }))
        )
      ).pipe(Effect.provide(BrowserPty.layerUnsupported))
    )

    expect(error).toMatchObject({
      code: "unsupported",
      message: "no pty in the browser (requested: bash)"
    })
  })
})
