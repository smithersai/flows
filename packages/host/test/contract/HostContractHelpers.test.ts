/**
 * The shared contract suite is itself test infrastructure every host package
 * depends on, so its two load-bearing helpers get their own cases: the code
 * normalizer must not invent a code, and the failure assertion must not let a
 * capability declared unsupported quietly succeed.
 */
import { Effect } from "effect"
import { tmpdir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { ShellError } from "../../src/HostError.ts"
import { assertFailure, defaultScratchPath, errorCode } from "./HostContract.ts"

describe("errorCode", () => {
  it("prefers a string `code` field", () => {
    expect(errorCode(new ShellError({ code: "timeout", message: "slow" }))).toBe("timeout")
  })

  it("falls back to a nested `reason._tag`", () => {
    expect(errorCode({ reason: { _tag: "TransportError" } })).toBe("TransportError")
  })

  it("falls back to a bare `_tag` when there is no reason", () => {
    expect(errorCode({ _tag: "NoFileUrls" })).toBe("NoFileUrls")
  })

  it("reports no code for values that carry none", () => {
    expect(errorCode(undefined)).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
    expect(errorCode("shell_unavailable")).toBeUndefined()
    expect(errorCode({})).toBeUndefined()
    expect(errorCode({ code: 500 })).toBeUndefined()
    expect(errorCode({ reason: "TransportError" })).toBeUndefined()
    expect(errorCode({ reason: { tag: "TransportError" } })).toBeUndefined()
    expect(errorCode({ _tag: 7 })).toBeUndefined()
  })
})

describe("assertFailure", () => {
  it("passes when the effect fails with the declared code", async () => {
    await expect(
      Effect.runPromise(assertFailure(Effect.fail(new ShellError({ code: "timeout", message: "slow" })), "timeout"))
    ).resolves.toBeUndefined()
  })

  it("rejects a capability declared unsupported that actually succeeds", async () => {
    await expect(Effect.runPromise(assertFailure(Effect.succeed("worked"), "unsupported")))
      .rejects.toThrow("expected typed failure unsupported")
  })

  it("rejects a failure carrying a different code", async () => {
    await expect(
      Effect.runPromise(
        assertFailure(Effect.fail(new ShellError({ code: "spawn_error", message: "no" })), "shell_unavailable")
      )
    ).rejects.toThrow()
  })
})

describe("defaultScratchPath", () => {
  const outsideCwd = (path: string) => {
    const rel = relative(process.cwd(), path)
    return rel.startsWith("..") || isAbsolute(rel)
  }

  it("is absolute and lands under the OS temp directory, never the working tree", () => {
    const path = defaultScratchPath("NodeHost defaults")
    expect(isAbsolute(path)).toBe(true)
    expect(path.startsWith(tmpdir() + sep)).toBe(true)
    expect(outsideCwd(path)).toBe(true)
  })

  it("scopes the path by process id so concurrent test processes cannot race it", () => {
    expect(defaultScratchPath("NodeHost defaults")).toContain(`-${process.pid}-`)
  })

  it("never hands the same path to two suites, or to one suite twice", () => {
    const paths = [
      defaultScratchPath("NodeHost defaults"),
      defaultScratchPath("NodeHost defaults"),
      defaultScratchPath("BunHost defaults")
    ]
    expect(new Set(paths).size).toBe(3)
  })

  it("keeps the suite name recognizable but path-safe", () => {
    const path = defaultScratchPath("NodeHost defaults/../escape")
    expect(path).toContain("nodehost-defaults")
    expect(path).not.toContain("..")
  })

  it("falls back to a stable slug when the suite name leaves nothing path-safe", () => {
    expect(defaultScratchPath("/../")).toMatch(/-host$/)
    expect(defaultScratchPath("")).toMatch(/-host$/)
  })
})
