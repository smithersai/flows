/**
 * The package barrel. Every consumer imports through it, so its namespace
 * re-exports are part of the public contract: a renamed or dropped module here
 * breaks callers without any single module's own tests noticing.
 */
import { describe, expect, it } from "vitest"
import * as Host from "../src/index.ts"

describe("@smithers/host barrel", () => {
  it("re-exports every service module as its own namespace", () => {
    expect(Object.keys(Host).sort()).toEqual([
      "BrowserHost",
      "BunHost",
      "HostBuiltinNames",
      "HostError",
      "HostServiceIds",
      "HostServiceTags",
      "HttpTransport",
      "Jj",
      "NodeHost",
      "Pty",
      "RemoteSandbox",
      "SandboxHealth",
      "Shell",
      "TestHost"
    ])
  })

  it("keeps each namespace's `make` / `makeNoop` / `layerNoop` trio distinct", () => {
    for (const namespace of [Host.Shell, Host.Pty, Host.HttpTransport]) {
      expect(typeof namespace.make).toBe("function")
      expect(typeof namespace.makeNoop).toBe("function")
      expect(typeof namespace.layerNoop).toBe("function")
    }
    expect(Host.Shell.makeNoop).not.toBe(Host.Pty.makeNoop)
  })

  it("exports the closed HostServices list flat, beside the namespaces", () => {
    expect(Host.HostServiceIds).toEqual([
      "effect/FileSystem",
      "effect/Path",
      "flows/host/Shell",
      "flows/host/Pty",
      "flows/host/Jj",
      "flows/host/HttpTransport"
    ])
    expect(Host.HostServiceTags).toHaveLength(Host.HostServiceIds.length)
    expect(Host.HostBuiltinNames).toEqual(["effect/Clock", "effect/Random"])
  })
})
