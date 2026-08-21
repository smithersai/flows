/**
 * The run's automatic call ledger.
 *
 * These cases fix what a line says and what it never says: a line names the
 * call and the shape of its result, and it carries no payload at all.
 */
import { describe, expect, it } from "vitest"
import * as CallLedger from "../src/CallLedger.ts"

const settlement = (
  flow: string,
  input: unknown,
  value: unknown = null,
  message?: string
): CallLedger.Settlement => ({
  flow,
  input: input as never,
  ok: message === undefined,
  value: value as never,
  ...(message === undefined ? {} : { message })
})

describe("CallLedger.subject", () => {
  it("names the first term of the input that names a target", () => {
    // The same lexer and the same target/condition split `NarrowedCheck` uses,
    // so a path, a test id, or the file inside a shell command is picked out
    // without this module knowing what any of those are.
    expect(CallLedger.subject({ command: "python -m pytest tests/test_a.py -q" })).toBe("tests/test_a.py")
    expect(CallLedger.subject({ limit: 70, offset: 100, path: "sphinx/util/rst.py" })).toBe("sphinx/util/rst.py")
  })

  it("quotes the whole input when nothing in it names a target", () => {
    expect(CallLedger.subject({ pattern: "fromstring" })).toBe("{\"pattern\":\"fromstring\"}")
  })

  it("skips a separator that names nothing, so a glob-only search is named by its own terms", () => {
    // `**/*.py` lexes to a bare `/` and a bare `.py`. Both carry a separator,
    // so `NarrowedCheck.targeting` accepts both, and neither tells a reader
    // which search this was.
    expect(CallLedger.subject({ globs: ["**/*.py"], pattern: "docinfo_re", root: "sphinx" })).toBe(
      "{\"globs\":[\"**/*.py\"],\"pattern\":\"docinfo_re\",\"root\":\"sphinx\"}"
    )
    expect(CallLedger.subject({ globs: ["**/*.py"], path: "sphinx/util/rst.py" })).toBe("sphinx/util/rst.py")
  })

  it("clips a subject longer than the line allows", () => {
    const subject = CallLedger.subject({ command: "x".repeat(400) })
    expect(subject).toHaveLength(CallLedger.width)
    expect(subject.endsWith("…")).toBe(true)
  })
})

describe("CallLedger.digest", () => {
  it("reports counts and statuses and never the payload", () => {
    expect(CallLedger.digest({ exitCode: 1, stdout: "boom\n", stdoutTruncated: false })).toBe(
      "exitCode=1 stdout=5b stdoutTruncated=false"
    )
    expect(CallLedger.digest({ matches: [1, 2, 3], truncated: true })).toBe("matches=[3] truncated=true")
    expect(CallLedger.digest({ nested: { deep: 1 } })).toBe("nested={…}")
    expect(CallLedger.digest({ missing: null })).toBe("missing=null")
  })

  it("names members in a stable order however the result was built", () => {
    expect(CallLedger.digest({ b: 1, a: 2 })).toBe(CallLedger.digest({ a: 2, b: 1 }))
  })

  it("caps how many members one line names, and says how many it left out", () => {
    const wide = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, index]))
    expect(CallLedger.digest(wide)).toBe("k0=0 k1=1 k2=2 k3=3 k4=4 k5=5 +3 more")
  })

  it("digests a result that is not an object at all", () => {
    expect(CallLedger.digest(null)).toBe("null")
    expect(CallLedger.digest(7)).toBe("7")
    expect(CallLedger.digest("hello")).toBe("5b")
    expect(CallLedger.digest([1, 2])).toBe("[2]")
  })

  it("clips a digest wider than the line allows", () => {
    const line = CallLedger.digest({ verylongkeyname: "x".repeat(10), other: "y".repeat(10) })
    expect(line.length).toBeLessThanOrEqual(CallLedger.width)
  })
})

describe("CallLedger.remember", () => {
  it("numbers calls across frames in one continuing sequence", () => {
    const first = CallLedger.remember([], [settlement("grep", { pattern: "x" })])
    const second = CallLedger.remember(first, [
      settlement("read", { path: "src/a.ts" }),
      settlement("bash", { command: "run src/a.ts" })
    ])

    expect(second.map((entry) => entry.ordinal)).toEqual([1, 2, 3])
    expect(second.map((entry) => entry.flow)).toEqual(["grep", "read", "bash"])
  })

  it("drops the oldest lines past the bound and keeps their ordinals honest", () => {
    const many = Array.from({ length: CallLedger.bound + 5 }, (_, index) => settlement("read", { path: `f${index}/a` }))
    const ledger = CallLedger.remember([], many)

    expect(ledger).toHaveLength(CallLedger.bound)
    expect(ledger[0]?.ordinal).toBe(6)
    expect(CallLedger.settled(ledger)).toBe(CallLedger.bound + 5)
  })

  it("records what the flow said about a failure, which is the whole of that result", () => {
    const ledger = CallLedger.remember([], [settlement("edit", { path: "a/b.py" }, null, "oldString does not occur")])
    expect(ledger[0]?.ok).toBe(false)
    expect(ledger[0]?.digest).toBe("oldString does not occur")
  })

  it("records a failure the flow said nothing about", () => {
    const ledger = CallLedger.remember([], [{ flow: "edit", input: { path: "a/b.py" }, ok: false, value: null }])
    expect(ledger[0]?.digest).toBe("failed")
  })
})

describe("CallLedger.render", () => {
  it("renders nothing at all before the run has settled a call", () => {
    expect(CallLedger.render([])).toBeUndefined()
    expect(CallLedger.settled([])).toBe(0)
  })

  it("renders one line per call, oldest first", () => {
    const ledger = CallLedger.remember([], [
      settlement("grep", { pattern: "def x", root: "src/lib" }, { matches: [1, 2] })
    ])

    expect(CallLedger.render(ledger)).toBe(
      "Calls this run has settled (1), oldest first. You have already asked these — read them here instead of asking again:\n" +
        "1. grep src/lib — ok: matches=[2]"
    )
  })

  it("states how many lines aged out rather than renumbering what is left", () => {
    const many = Array.from({ length: CallLedger.bound + 2 }, (_, index) => settlement("read", { path: `f${index}/a` }))
    const rendered = CallLedger.render(CallLedger.remember([], many)) ?? ""

    expect(rendered).toContain(
      `Calls this run has settled (${CallLedger.bound + 2}), oldest first; the 2 oldest are not listed`
    )
    expect(rendered).toContain("3. read f2/a")
  })
})
