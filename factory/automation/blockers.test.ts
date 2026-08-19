/**
 * Blocker classification.
 *
 * The asymmetry is the point: a failure the classifier does not recognise must
 * come back `unrelated: false`, because a false "blocked" parks a real bug and
 * a false "not blocked" only costs a re-run.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { blockerBody, blockerTitle, classify, unclassified } from "./blockers.ts"

describe("classify", () => {
  it("recognises an install failure", () => {
    const verdict = classify("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"")
    assert.equal(verdict.kind, "install")
    assert.equal(verdict.unrelated, true)
  })

  it("recognises a quota exhaustion", () => {
    assert.equal(classify("HTTP 429: Too Many Requests").kind, "quota")
    assert.equal(classify("rate limit exceeded, retry after 60s").kind, "quota")
  })

  it("recognises a missing toolchain and an unreachable host", () => {
    assert.equal(classify("jj: command not found").kind, "toolchain")
    assert.equal(classify("getaddrinfo ENOTFOUND registry.npmjs.org").kind, "network")
  })

  it("recognises a red baseline on main", () => {
    assert.equal(classify("note: the baseline is already red before this change").kind, "baseline")
  })

  it("returns unclassified, and NOT unrelated, for a failure it does not know", () => {
    const verdict = classify("AssertionError: expected 3 to equal 4")
    assert.deepEqual(verdict, unclassified)
    assert.equal(verdict.unrelated, false)
  })

  it("judges the tail, so an early recovered warning does not outvote the failure", () => {
    const log = `${"ERR_PNPM_NO_MATCHING_VERSION retrying\n".repeat(10)}${"x\n".repeat(4000)}`
    assert.equal(classify(log, 1024).kind, "unclassified")
  })
})

describe("the blocker issue", () => {
  it("titles itself with the classification summary", () => {
    assert.equal(blockerTitle(classify("HTTP 429: Too Many Requests")), "infra: a provider quota or rate limit was exhausted")
  })

  it("names the parked reports and says closing unparks them", () => {
    const body = blockerBody(classify("jj: command not found"), "jj: command not found", [7, 9])
    assert.ok(body.includes("#7, #9"))
    assert.ok(body.includes("unparks them"))
    assert.ok(body.includes("`toolchain`"))
  })

  it("says so plainly when nothing is parked yet", () => {
    assert.ok(blockerBody(unclassified, "boom", []).includes("No reports are parked on this yet."))
  })
})
