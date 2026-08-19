/**
 * The agent seam, the reply reading built on it, and the queue item a verified
 * repro produces.
 */
import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { read } from "./advance.ts"
import { ask, askJson, claudeText, currentEngine, setEngine, stubEngine } from "./agent.ts"
import { itemPath, render, routing, slug } from "./queue.ts"
import { hasScenario, renderReview } from "./review.ts"

const original = currentEngine()

afterEach(() => {
  setEngine(original)
})

describe("the seam", () => {
  it("routes every ask through the installed engine and records the prompt", () => {
    const stub = stubEngine(["an answer"])
    setEngine(stub)
    assert.equal(ask({ prompt: "a question" }), "an answer")
    assert.deepEqual(stub.prompts, ["a question"])
  })

  it("parses a fenced JSON answer", () => {
    setEngine(stubEngine(["```json\n{\"ok\": true}\n```"]))
    assert.deepEqual(askJson({ prompt: "x" }), { ok: true })
  })

  it("parses an unfenced JSON answer", () => {
    setEngine(stubEngine(["{\"ok\": false}"]))
    assert.deepEqual(askJson({ prompt: "x" }), { ok: false })
  })

  it("fails rather than guessing when the answer is not JSON", () => {
    setEngine(stubEngine(["I think the answer is yes"]))
    assert.throws(() => askJson({ prompt: "x" }))
  })

  it("says when it ran out of scripted replies", () => {
    setEngine(stubEngine([]))
    assert.throws(() => ask({ prompt: "x" }), /ran out of replies/)
  })
})

describe("claudeText", () => {
  it("reads the result out of the envelope", () => {
    assert.equal(claudeText(JSON.stringify({ result: "hello" })), "hello")
  })

  it("surfaces an error envelope instead of returning its text", () => {
    assert.throws(() => claudeText(JSON.stringify({ is_error: true, result: "no" })), /reported an error/)
  })

  it("refuses an envelope it does not recognise", () => {
    assert.throws(() => claudeText(JSON.stringify({ content: "hello" })), /unexpected claude CLI output/)
  })
})

describe("reading a reporter's reply", () => {
  it("decides the plain cases without asking the model", () => {
    const never = (): string => {
      throw new Error("the agent should not have been consulted")
    }
    assert.equal(read("yes, that is it", never), "confirm")
    assert.equal(read("no, it needs two files", never), "reject")
  })

  it("asks the model only for the ambiguous ones", () => {
    assert.equal(read("thanks for looking!", () => "unclear"), "unclear")
    assert.equal(read("that is what I meant", () => "confirm"), "confirm")
  })

  it("treats an unrecognised model answer as unclear rather than guessing", () => {
    assert.equal(read("hmm", () => "probably yes?"), "unclear")
  })
})

describe("the queue item", () => {
  it("derives priority from labels and always anchors on the tip", () => {
    assert.deepEqual(routing([]), { status: "queued", anchor: "head", priority: "p1" })
    assert.equal(routing(["p0"]).priority, "p0")
    assert.equal(routing(["severity:low"]).priority, "p2")
  })

  it("slugs the issue number and the first words of the title", () => {
    assert.equal(slug(42, "Edit blocks: CRLF files never match"), "issue-42-edit-blocks-crlf-files-never-match")
    assert.equal(slug(42, "!!!"), "issue-42")
    assert.equal(itemPath(42, "!!!"), "factory/queue/issue-42.md")
  })

  it("states both landing constraints the proof gate reads", () => {
    const item = render({
      issue: 42,
      title: "CRLF files never match",
      labels: ["repro:verified"],
      reproProgram: "factory/repros/42/attempt-1.ts",
      claim: "the locator normalises the needle but not the haystack"
    })
    assert.ok(item.includes("status: queued"))
    assert.ok(item.includes("Closes #42"))
    assert.ok(item.includes("factory/repros/42/"))
    assert.ok(item.includes("permanent regression"))
  })
})

describe("the review body", () => {
  it("drops a finding with no concrete scenario", () => {
    assert.equal(hasScenario({ file: "a.ts", line: 1, severity: "warning", message: "m", scenario: "could break" }), false)
    assert.equal(hasScenario({ file: "a.ts", line: 1, severity: "warning", message: "m", scenario: "" }), false)
    assert.equal(
      hasScenario({
        file: "a.ts",
        line: 1,
        severity: "error",
        message: "m",
        scenario: "with an empty paths array, resolved[0] is undefined and the root check passes"
      }),
      true
    )
  })

  it("says an empty review found nothing rather than looked at nothing", () => {
    const body = renderReview([])
    assert.ok(body.includes("No findings"))
    assert.ok(body.includes("not that none was looked for"))
  })

  it("orders findings by severity, then file, then line", () => {
    const body = renderReview([
      { file: "b.ts", line: 2, severity: "info", message: "i", scenario: "with a null argument the branch is skipped" },
      { file: "a.ts", line: 9, severity: "error", message: "e", scenario: "with a null argument the call throws" }
    ])
    assert.ok(body.indexOf("a.ts:9") < body.indexOf("b.ts:2"))
    assert.ok(body.includes("**Fails when:**"))
  })
})
