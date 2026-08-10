/**
 * The package barrel. Every consumer imports through it, so its namespace
 * re-exports are part of the public contract: a renamed or dropped module here
 * breaks callers without any single module's own tests noticing.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Host from "../src/index.ts"

describe("@smthrs/host barrel", () => {
  it("re-exports every service module as its own namespace", () => {
    expect(Object.keys(Host).sort()).toEqual([
      "HostBuiltinNames",
      "HostError",
      "HostServiceIds",
      "HostServiceTags",
      "HttpTransport",
      "Shell"
    ])
  })

  /**
   * The hard constraint of the host split: `Jj`, `Pty`, `RemoteSandbox`, and
   * `SandboxHealth` are their own packages now. `HostServices.ts` still depends
   * on the first two because they remain part of the closed Host surface, but a
   * dependency is not a re-export — a compatibility shim here would let every
   * consumer keep the old import and make the split cosmetic.
   */
  it("does not re-export the modules that moved to their own packages", () => {
    for (const name of ["Jj", "Pty", "RemoteSandbox", "SandboxHealth"]) {
      expect(Host).not.toHaveProperty(name)
    }
  })

  /**
   * Browser support is a hard requirement, and the root is the entry point that
   * has to keep it: a platform bundle re-exported here resolves `node:` modules
   * before any bundler can tree-shake it (REVIEW.md blocker 7). Implementations
   * live under `/node`, `/bun`, `/browser`, and `/test` subpaths, and
   * `scripts/browser-check.mjs` bundles this module for the browser in CI.
   */
  it("keeps platform and test bundles out of the browser-safe root", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    const reexported = [...source.matchAll(/^export \* as \w+ from "(.+)"$/gm)].flatMap((match) => match[1] ?? [])
    expect(reexported.filter((module) => /^\.\/(node|bun|browser|test)\//.test(module))).toEqual([])
    for (const name of ["NodeHost", "BunHost", "BrowserHost", "TestHost"]) {
      expect(Host).not.toHaveProperty(name)
    }
  })

  it("keeps each namespace's `make` / `makeNoop` / `layerNoop` trio distinct", () => {
    for (const namespace of [Host.Shell, Host.HttpTransport]) {
      expect(typeof namespace.make).toBe("function")
      expect(typeof namespace.makeNoop).toBe("function")
      expect(typeof namespace.layerNoop).toBe("function")
    }
    expect(Host.Shell.makeNoop).not.toBe(Host.HttpTransport.makeNoop)
  })

  it("exports the closed HostServices list flat, beside the namespaces", () => {
    expect(Host.HostServiceIds).toEqual([
      "effect/FileSystem",
      "effect/Path",
      "flows/host/Shell",
      // FROZEN: `Pty` and `Jj` moved to their own packages without changing
      // behaviour, and these strings are digested into step keys.
      "flows/host/Pty",
      "flows/host/Jj",
      "flows/host/HttpTransport"
    ])
    expect(Host.HostServiceTags).toHaveLength(Host.HostServiceIds.length)
    expect(Host.HostBuiltinNames).toEqual(["effect/Clock", "effect/Random"])
  })
})
