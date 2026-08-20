/**
 * The repro state machine.
 *
 * These are the tests that decide whether a report is treated fairly. The two
 * that matter most: a blocker never adds `repro:needs-info`, and a repro is
 * verified only when the PoC fails on main AND the reporter confirmed it.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  attemptsFrom,
  duplicateLabel,
  managedLabels,
  maximumPocAttempts,
  pocMarker,
  readsAsConfirmation,
  readsAsRejection,
  transition
} from "./labels.ts"

describe("transition", () => {
  it("labels a strong duplicate and halts for a maintainer", () => {
    const edit = transition({ kind: "intake", strongDuplicate: true }, [])
    assert.deepEqual(edit.add, [duplicateLabel])
    assert.equal(edit.halt, true)
  })

  it("does nothing on an intake that found no duplicate", () => {
    const edit = transition({ kind: "intake", strongDuplicate: false }, ["poc:proposed"])
    assert.deepEqual(edit.add, [])
    assert.deepEqual(edit.remove, [])
    assert.equal(edit.halt, false)
  })

  it("only asks to remove labels the issue actually carries", () => {
    const edit = transition({ kind: "poc-proposed" }, ["poc:rejected"])
    assert.deepEqual(edit.add, ["poc:proposed"])
    assert.deepEqual(edit.remove, ["poc:rejected"])
    for (const label of edit.remove) assert.ok(managedLabels.includes(label))
  })

  it("never asks to remove a label that is not there", () => {
    const edit = transition({ kind: "poc-proposed" }, [])
    assert.deepEqual(edit.remove, [])
  })

  it("verifies only when the PoC fails on main and the reporter confirmed", () => {
    const withoutConfirmation = transition({ kind: "poc-failed-on-main" }, ["poc:proposed"])
    assert.deepEqual(withoutConfirmation.add, [])
    assert.equal(withoutConfirmation.halt, true)

    const withConfirmation = transition({ kind: "poc-failed-on-main" }, ["poc:confirmed"])
    assert.deepEqual(withConfirmation.add, ["repro:verified"])
    assert.equal(withConfirmation.halt, false)
  })

  it("asks for information when the PoC passes on main", () => {
    const edit = transition({ kind: "poc-passed-on-main" }, [])
    assert.deepEqual(edit.add, ["repro:needs-info"])
    assert.equal(edit.halt, true)
  })

  it("loops on a rejection until the attempt bound, then asks a person", () => {
    const early = transition({ kind: "reporter-rejected", attempts: 1 }, ["poc:proposed"])
    assert.deepEqual(early.add, ["poc:rejected"])
    assert.equal(early.halt, false)

    const exhausted = transition({ kind: "reporter-rejected", attempts: maximumPocAttempts }, ["poc:proposed"])
    assert.deepEqual(exhausted.add, ["poc:rejected", "repro:needs-info"])
    assert.equal(exhausted.halt, true)
  })

  it("never counts a blocker against the reporter", () => {
    const edit = transition({ kind: "blocked", blocker: "#12" }, ["poc:proposed"])
    assert.deepEqual(edit.add, ["repro:blocked"])
    assert.ok(!edit.add.includes("repro:needs-info"))
    assert.ok(edit.reason.includes("unrelated"))
  })

  it("unparks by removing the blocked label, and only when it is present", () => {
    assert.deepEqual(transition({ kind: "blocker-cleared" }, ["repro:blocked"]).remove, ["repro:blocked"])
    assert.deepEqual(transition({ kind: "blocker-cleared" }, []).remove, [])
  })
})

describe("reading a reply", () => {
  it("reads a plain yes and a plain no", () => {
    assert.equal(readsAsConfirmation("yes, that is exactly it"), true)
    assert.equal(readsAsConfirmation("Confirmed."), true)
    assert.equal(readsAsRejection("no, the error happens on write not read"), true)
    assert.equal(readsAsRejection("Not quite - it needs two files"), true)
  })

  it("reads anything else as neither", () => {
    for (const body of ["thanks for looking at this!", "any update?", "I will check tomorrow"]) {
      assert.equal(readsAsConfirmation(body), false, body)
      assert.equal(readsAsRejection(body), false, body)
    }
  })
})

describe("attemptsFrom", () => {
  it("counts proposals by their marker, not by a stored counter", () => {
    assert.equal(attemptsFrom([]), 0)
    assert.equal(attemptsFrom(["hello", `${pocMarker} first`, "reply", `${pocMarker} second`]), 2)
  })
})
