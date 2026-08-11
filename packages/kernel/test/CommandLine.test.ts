/**
 * `CommandLine.render` is the string a `proc:spawn` grant is written against
 * and the line the browser interpreter actually runs. Those two must never
 * disagree, so the rendering rules get their own cases.
 */
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { describe, expect, it } from "vitest"
import * as CommandLine from "../src/CommandLine.ts"

describe("CommandLine.render", () => {
  it("leaves a bare command and shell-safe arguments unquoted", () => {
    expect(CommandLine.render(ChildProcess.make("git", ["status", "--short"]))).toBe("git status --short")
    expect(CommandLine.render(ChildProcess.make("/usr/bin/curl", ["https://example.com/a?b"])))
      .toBe("/usr/bin/curl 'https://example.com/a?b'")
  })

  it("single-quotes anything with whitespace, an empty argument, or a metacharacter", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"]))).toBe("echo 'a b'")
    expect(CommandLine.render(ChildProcess.make("echo", [""]))).toBe("echo ''")
    expect(CommandLine.render(ChildProcess.make("echo", ["a;rm -rf /"]))).toBe("echo 'a;rm -rf /'")
  })

  it("escapes an embedded single quote so the rendering cannot break out of it", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["it's"]))).toBe("echo 'it'\\''s'")
  })

  it("renders shell commands verbatim so the capability names what executes", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["safe; touch /tmp/marker"], { shell: true })))
      .toBe("echo safe; touch /tmp/marker")
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"], { shell: "/bin/sh" })))
      .toBe("/bin/sh -c 'echo a b'")
    expect(CommandLine.render(ChildProcess.make("echo", ["it's"], { shell: "/custom shell" })))
      .toBe("'/custom shell' -c 'echo it'\\''s'")
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"], { shell: false })))
      .toBe("echo 'a b'")
  })

  it("renders a pipeline with `|` between its stages", () => {
    const pipeline = ChildProcess.make("printf", ["a b"]).pipe(
      ChildProcess.pipeTo(ChildProcess.make("grep", ["a"]))
    )

    expect(CommandLine.render(pipeline)).toBe("printf 'a b' | grep a")
  })
})

describe("CommandLine.cwd and CommandLine.env", () => {
  it("reads the options off a standard command", () => {
    const command = ChildProcess.make("ls", [], { cwd: "/work", env: { A: "1" } })

    expect(CommandLine.cwd(command)).toBe("/work")
    expect(CommandLine.env(command)).toEqual({ A: "1" })
  })

  it("is undefined when a command declares neither", () => {
    expect(CommandLine.cwd(ChildProcess.make("ls"))).toBeUndefined()
    expect(CommandLine.env(ChildProcess.make("ls"))).toBeUndefined()
  })

  it("takes the leftmost stage of a pipeline", () => {
    const pipeline = ChildProcess.make("ls", [], { cwd: "/left", env: { SIDE: "left" } }).pipe(
      ChildProcess.pipeTo(ChildProcess.make("wc", [], { cwd: "/right", env: { SIDE: "right" } }))
    )

    expect(CommandLine.cwd(pipeline)).toBe("/left")
    expect(CommandLine.env(pipeline)).toEqual({ SIDE: "left" })
  })
})
