/**
 * The proof gate's two pure decisions: which issues a pull request claims, and
 * whether its diff actually carries a repro for them.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { claimedIssues, touchedPrograms } from "./proof.ts"

describe("claimedIssues", () => {
  it("reads every closing keyword GitHub honours", () => {
    const body = "Closes #12. Also fixes #13 and resolved #14."
    assert.deepEqual(claimedIssues(body), [12, 13, 14])
  })

  it("is case insensitive and deduplicates", () => {
    assert.deepEqual(claimedIssues("CLOSES #9\nfix #9"), [9])
  })

  it("ignores a bare issue reference, which is a mention and not a claim", () => {
    assert.deepEqual(claimedIssues("related to #12, see also #13"), [])
  })

  it("reads an empty body as claiming nothing", () => {
    assert.deepEqual(claimedIssues(""), [])
  })
})

describe("touchedPrograms", () => {
  it("finds the repro programs for the claimed issues", () => {
    const files = [
      "factory/repros/12/attempt-1.ts",
      "factory/repros/12/attempt-1.md",
      "packages/std/src/Edit.ts"
    ]
    assert.deepEqual(touchedPrograms(files, [12]), ["factory/repros/12/attempt-1.ts"])
  })

  it("does not accept a repro filed under a different issue", () => {
    assert.deepEqual(touchedPrograms(["factory/repros/13/attempt-1.ts"], [12]), [])
  })

  it("does not accept a prefix collision", () => {
    assert.deepEqual(touchedPrograms(["factory/repros/123/attempt-1.ts"], [12]), [])
  })

  it("returns nothing when the pull request touches no repro at all", () => {
    assert.deepEqual(touchedPrograms(["packages/std/src/Edit.ts"], [12]), [])
  })
})
