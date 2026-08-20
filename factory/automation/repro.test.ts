/**
 * The proof-of-concept pair, the result it produces, and the comment that puts
 * it in front of the reporter.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  attempts,
  directory,
  nextAttempt,
  notePath,
  parseNote,
  programPath,
  proposalComment,
  readResult,
  renderNote,
  write,
  writeResult
} from "./repro.ts"
import type { Repro, Result } from "./repro.ts"

const repro: Repro = {
  issue: 42,
  attempt: 1,
  claim: "Applying an edit block to a CRLF file reports no match.",
  steps: ["write a file with CRLF line endings", "apply an edit block that matches its text"],
  expected: "the block applies",
  actual: "the locator reports no match",
  program: "process.exit(1)\n"
}

const result: Result = { issue: 42, attempt: 1, failed: true, exitCode: 1, log: "no match reported" }

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "factory-repro-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("the pair", () => {
  it("names both halves under the issue's directory", () => {
    assert.equal(directory(42), "factory/repros/42")
    assert.equal(notePath(42, 1), "factory/repros/42/attempt-1.md")
    assert.equal(programPath(42, 1), "factory/repros/42/attempt-1.ts")
  })

  it("round-trips the claim and the steps through the note", () => {
    const parsed = parseNote(renderNote(repro))
    assert.equal(parsed.issue, 42)
    assert.equal(parsed.attempt, 1)
    assert.equal(parsed.claim, repro.claim)
    assert.deepEqual(parsed.steps, repro.steps)
  })

  it("tells the reader that a non-zero exit means the bug is present", () => {
    assert.ok(renderNote(repro).includes("A non-zero exit means the bug is present."))
  })

  it("refuses a note that does not open with its heading", () => {
    assert.throws(() => parseNote("## Steps\n"), /issue and attempt heading/)
  })
})

describe("attempts on disk", () => {
  it("starts at one and counts what is written", () => {
    assert.deepEqual(attempts(42, root), [])
    assert.equal(nextAttempt(42, root), 1)
    write(repro, root)
    assert.deepEqual(attempts(42, root), [1])
    assert.equal(nextAttempt(42, root), 2)
    write({ ...repro, attempt: 2 }, root)
    assert.deepEqual(attempts(42, root), [1, 2])
  })

  it("round-trips a recorded result", () => {
    writeResult(result, root)
    assert.deepEqual(readResult(42, 1, root), result)
    assert.equal(readResult(42, 2, root), undefined)
  })
})

describe("the proposal comment", () => {
  it("asks the reporter a yes or no question and carries the marker", () => {
    const body = proposalComment(repro, result, "<!-- factory:poc -->")
    assert.ok(body.startsWith("<!-- factory:poc -->"))
    assert.ok(body.includes("**Does this capture your issue?**"))
    assert.ok(body.includes("fails on `main`"))
  })

  it("says plainly when the program did not fail", () => {
    const body = proposalComment(repro, { ...result, failed: false, exitCode: 0 }, "<!-- factory:poc -->")
    assert.ok(body.includes("passes on `main`"))
    assert.ok(body.includes("does not yet reproduce"))
  })
})
