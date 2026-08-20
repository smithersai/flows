/**
 * Telling an invalid probe from a failing check.
 *
 * The cases fix one property: a classification is only made when the command
 * failed *about itself*. Every recogniser is exercised against output a real
 * runner prints, and the negative cases are the ones that matter more — a false
 * positive suppresses genuine regression evidence.
 */
import { describe, expect, it } from "vitest"
import * as Probe from "../src/Probe.ts"

const failing = (text: string, exitCode = 1) => Probe.classify({ exitCode, stdout: "", stderr: text })

describe("Probe.classify", () => {
  it("never classifies a command that exited zero, whatever it printed", () => {
    expect(
      Probe.classify({
        exitCode: 0,
        stdout: "unittest.loader._FailedTest",
        stderr: "ModuleNotFoundError: No module named 'nope'"
      })
    ).toBeUndefined()
  })

  it("reads unittest's synthesised placeholder as a test that does not exist", () => {
    const probe = failing(
      "ERROR: test_missing (unittest.loader._FailedTest.test_missing)\nAttributeError: module has none"
    )
    expect(probe?.reason).toBe("unknown-test")
  })

  it("reads a missing test method on a real class as a test that does not exist", () => {
    // The django wave-3 case, verbatim: exit 1, and nothing about the tree.
    const probe = failing(
      "AttributeError: type object 'AdminViewBasicTest' has no attribute 'test_catch_all_view_append_slash'"
    )
    expect(probe).toMatchObject({ reason: "unknown-test" })
    expect(probe?.evidence).toContain("test_catch_all_view_append_slash")
  })

  it("reads pytest's unresolvable node id as a test that does not exist", () => {
    expect(failing("ERROR: not found: /repo/tests/test_admin.py::test_nope")?.reason).toBe("unknown-test")
  })

  it("reads pytest's missing collection root as a path that does not exist", () => {
    expect(failing("ERROR: file or directory not found: tests/test_absent.py")?.reason).toBe("unknown-path")
  })

  it("reads a python interpreter that could not open its script as a path that does not exist", () => {
    expect(failing("python: can't open file '/repo/repro.py': [Errno 2] No such file or directory")?.reason).toBe(
      "unknown-path"
    )
  })

  it("reads both import errors as a module that does not exist", () => {
    expect(failing("ModuleNotFoundError: No module named 'django.contrib.nope'")?.reason).toBe("unknown-module")
    expect(failing("ImportError: No module named tests.helpers")?.reason).toBe("unknown-module")
  })

  it("reads a runner's unknown environment as an environment that does not exist", () => {
    expect(failing("ERROR: unknown environment 'py313'")?.reason).toBe("unknown-environment")
  })

  it("reads both shells' phrasing as a program that does not exist", () => {
    expect(failing("bash: line 1: pytest: command not found", 127)?.reason).toBe("unknown-command")
    expect(failing("sh: 1: pytest: not found", 127)?.reason).toBe("unknown-command")
  })

  it("falls back to the POSIX exit codes when the shell printed nothing recognisable", () => {
    // 127 is "not found" and 126 is "found and not executable"; no test runner
    // reaches its own tests and then reports either.
    expect(Probe.classify({ exitCode: 127, stdout: "", stderr: "" })).toMatchObject({
      reason: "unknown-command",
      evidence: "the command exited 127"
    })
    expect(Probe.classify({ exitCode: 126, stdout: "", stderr: "" })?.reason).toBe("unknown-command")
  })

  it("leaves an ordinary failing check alone", () => {
    const output = [
      "FAILED tests/test_admin.py::AdminViewBasicTest::test_catch_all_view - AssertionError",
      "assert 301 == 404",
      "1 failed, 412 passed in 3.20s"
    ].join("\n")
    expect(Probe.classify({ exitCode: 1, stdout: output, stderr: "" })).toBeUndefined()
  })

  it("leaves an attribute error about anything but a test alone", () => {
    expect(failing("AttributeError: 'Model' object has no attribute 'related_name'")).toBeUndefined()
  })

  it("leaves an ordinary missing file alone", () => {
    // The phrase on its own is what half of every failing suite prints; only
    // the runner's own load-time wording is evidence.
    expect(failing("OSError: [Errno 2] No such file or directory: '/tmp/fixture'")).toBeUndefined()
  })

  it("classifies from stdout as readily as from stderr, and from both together", () => {
    expect(Probe.classify({ exitCode: 1, stdout: "ERROR: not found: t.py::x", stderr: "" })?.reason).toBe(
      "unknown-test"
    )
    expect(
      Probe.classify({ exitCode: 1, stdout: "collecting …", stderr: "ERROR: not found: t.py::x" })?.reason
    ).toBe("unknown-test")
  })

  it("quotes the whole matched line as evidence and clips a long one", () => {
    const probe = Probe.classify({
      exitCode: 1,
      stdout: "collected 0 items\nERROR: not found: tests/test_admin.py::nope\n1 error",
      stderr: ""
    })
    expect(probe?.evidence).toBe("ERROR: not found: tests/test_admin.py::nope")

    const long = Probe.classify({
      exitCode: 1,
      stdout: `ERROR: not found: ${"x".repeat(600)}`,
      stderr: ""
    })
    expect(long?.evidence).toHaveLength(240)
    expect(long?.evidence.endsWith("…")).toBe(true)
  })

  it("states what the failure does and does not prove, in the result itself", () => {
    const probe = failing("ERROR: not found: t.py::x")
    expect(probe?.message).toContain("never ran a check")
    expect(probe?.message).toContain("not a reproduction")
  })

  it("names the reserved output key flows report under", () => {
    expect(Probe.key).toBe("invalidProbe")
  })
})
