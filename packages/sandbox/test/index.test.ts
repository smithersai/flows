/**
 * The package barrel. Every consumer imports through it, so its namespace
 * re-exports are part of the public contract: a renamed or dropped module here
 * breaks callers without any single module's own tests noticing.
 */
import { describe, expect, it } from "vitest"
import * as Sandbox from "../src/index.ts"

describe("@smthrs/sandbox barrel", () => {
  it("re-exports every module as its own namespace", () => {
    expect(Object.keys(Sandbox).sort()).toEqual(["RemoteSandbox", "SandboxHealth"])
  })

  /**
   * The schema `_tag`s round-trip through the journal, so moving these modules
   * out of the dissolved `@smthrs/host` must not rename them.
   */
  it("keeps the `flows/host/…` identity strings the durable record depends on", () => {
    expect(Sandbox.SandboxHealth.SandboxHealth.key).toBe("flows/host/SandboxHealth")
    expect(Sandbox.RemoteSandbox.Provider.key).toBe("flows/host/RemoteSandbox/Provider")
    expect(new Sandbox.RemoteSandbox.ProviderError({ code: "unknown", message: "x" })._tag)
      .toBe("flows/host/RemoteSandbox/ProviderError")
  })
})
