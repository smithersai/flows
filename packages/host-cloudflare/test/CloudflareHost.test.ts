import * as Jj from "@flows/host/Jj"
import * as Pty from "@flows/host/Pty"
import * as Shell from "@flows/host/Shell"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CloudflareHost from "../src/CloudflareHost.ts"

const store = { get: async () => undefined, put: async () => {}, delete: async () => {}, list: async () => [] }
describe("CloudflareHost", () => {
  it("provides typed unavailable local process services", async () => {
    const layer = CloudflareHost.layer(store)
    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell.Shell
        const pty = yield* Pty.Pty
        const jj = yield* Jj.Jj
        return {
          shell: yield* Effect.flip(shell.exec("echo no")),
          pty: yield* Effect.scoped(Effect.flip(pty.spawn("sh", { cols: 1, rows: 1 }))),
          jj: yield* Effect.flip(jj.status())
        }
      }).pipe(Effect.provide(layer))
    )

    expect(errors.shell.code).toBe("shell_unavailable")
    expect(errors.pty.code).toBe("unsupported")
    expect(errors.jj.code).toBe("not_installed")
  })
})
