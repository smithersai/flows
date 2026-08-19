/**
 * The door schema.
 *
 * Two properties matter here. The decode accepts both payload shapes the
 * automation sees, and it bounds every text field before it can reach a
 * prompt.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  boundedText,
  decodeComment,
  decodeLabels,
  decodeReport,
  DecodeError,
  maximumBodyLength,
  reproDirectory,
  reproKey
} from "./schema.ts"

const webhook = {
  number: 12,
  title: "the locator misses CRLF files",
  body: "steps here",
  labels: [{ name: "bug" }, { name: "repro:verified" }],
  state: "open",
  user: { login: "reporter" },
  author_association: "CONTRIBUTOR"
}

const cli = {
  number: 12,
  title: "the locator misses CRLF files",
  body: "steps here",
  labels: [{ name: "bug" }],
  state: "OPEN",
  author: { login: "reporter" }
}

describe("decodeReport", () => {
  it("accepts the webhook payload shape", () => {
    const report = decodeReport(webhook)
    assert.equal(report.number, 12)
    assert.deepEqual(report.labels, ["bug", "repro:verified"])
    assert.equal(report.author, "reporter")
    assert.equal(report.authorAssociation, "CONTRIBUTOR")
    assert.equal(report.state, "open")
  })

  it("accepts the gh CLI shape, including its uppercase state", () => {
    const report = decodeReport({ ...cli, state: "CLOSED" })
    assert.equal(report.state, "closed")
    assert.equal(report.author, "reporter")
  })

  it("refuses a payload that is not an issue", () => {
    assert.throws(() => decodeReport(null), DecodeError)
    assert.throws(() => decodeReport({ number: "12" }), /number is not a positive integer/)
    assert.throws(() => decodeReport({ number: 0 }), /number is not a positive integer/)
  })

  it("treats a missing body as empty rather than failing", () => {
    assert.equal(decodeReport({ ...webhook, body: null }).body, "")
  })

  it("refuses a body that is not text", () => {
    assert.throws(() => decodeReport({ ...webhook, body: { toString: "no" } }), /body is not text/)
  })

  it("bounds a hostile body and says that it did", () => {
    const report = decodeReport({ ...webhook, body: "x".repeat(maximumBodyLength + 5_000) })
    assert.ok(report.body.length < maximumBodyLength + 200)
    assert.ok(report.body.endsWith("by the factory decoder]"))
  })
})

describe("decodeLabels", () => {
  it("reads both the object and the plain-string form", () => {
    assert.deepEqual(decodeLabels([{ name: "a" }, "b"]), ["a", "b"])
  })

  it("reads a missing list as empty and refuses a non-list", () => {
    assert.deepEqual(decodeLabels(undefined), [])
    assert.throws(() => decodeLabels("bug"), /labels is not a list/)
  })
})

describe("decodeComment", () => {
  it("reads the body, the author, and the timestamp under either spelling", () => {
    const fromWebhook = decodeComment({ body: "yes", user: { login: "r" }, created_at: "2026-08-01T00:00:00Z" })
    const fromCli = decodeComment({ body: "yes", author: { login: "r" }, createdAt: "2026-08-01T00:00:00Z" })
    assert.equal(fromWebhook.createdAt, fromCli.createdAt)
    assert.equal(fromWebhook.author, "r")
  })
})

describe("boundedText", () => {
  it("repairs a lone surrogate rather than passing it on", () => {
    assert.ok(boundedText("ok\uD800", 100, "body").isWellFormed())
  })
})

describe("repro identity", () => {
  it("keys a repro by issue number, not by content", () => {
    assert.equal(reproKey(decodeReport(webhook)), "issue-12")
    assert.equal(reproDirectory(decodeReport(webhook)), "factory/repros/12")
  })
})
