/**
 * The issue-memory corpus: round-tripping entries, and the index it derives.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  candidates,
  entryPath,
  indexFile,
  memoryDirectory,
  parse,
  read,
  readAll,
  render,
  renderIndex,
  score,
  write
} from "./memory.ts"
import type { Entry } from "./memory.ts"

const entry: Entry = {
  issue: 42,
  title: "Edit blocks: locating a block fails when the file uses CRLF",
  labels: ["repro:verified", "poc:confirmed"],
  state: "open",
  reproKey: "issue-42",
  related: [7],
  summary: "Applying an edit block to a CRLF file reports no match. The locator normalises the search text but not the haystack."
}

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "factory-memory-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("render and parse", () => {
  it("round-trips one entry", () => {
    assert.deepEqual(parse(render(entry)), entry)
  })

  it("survives a title carrying a colon", () => {
    const withColon = { ...entry, title: "build: the lockfile check reads the wrong file" }
    assert.equal(parse(render(withColon)).title, withColon.title)
  })

  it("omits an absent repro key rather than writing an empty one", () => {
    const rendered = render({ ...entry, reproKey: undefined })
    assert.ok(!rendered.includes("reproKey"))
    assert.equal(parse(rendered).reproKey, undefined)
  })

  it("refuses a file without frontmatter instead of inventing defaults", () => {
    assert.throws(() => parse("# just a heading\n"), /must open with YAML frontmatter/)
  })

  it("refuses an entry with no issue number", () => {
    assert.throws(() => parse("---\ntitle: \"x\"\n---\n\nbody\n"), /positive issue number/)
  })
})

describe("write", () => {
  it("writes the entry and derives the index from the directory", () => {
    write(entry, root)
    write({ ...entry, issue: 7, title: "Second report", reproKey: undefined, related: [] }, root)
    assert.equal(readAll(root).map((found) => found.issue).join(","), "7,42")
    const index = readFileSync(join(root, memoryDirectory, indexFile), "utf8")
    assert.ok(index.includes("| #7 |"))
    assert.ok(index.includes("| #42 |"))
    assert.ok(index.includes("This page is generated."))
  })

  it("reads one entry back by number, and undefined for an untriaged issue", () => {
    write(entry, root)
    assert.equal(read(42, root)?.title, entry.title)
    assert.equal(read(43, root), undefined)
  })

  it("escapes a pipe in a title so the index table survives it", () => {
    write({ ...entry, issue: 5, title: "a | b" }, root)
    assert.ok(readFileSync(join(root, memoryDirectory, indexFile), "utf8").includes("a \\| b"))
  })

  it("files each entry under its own number", () => {
    write(entry, root)
    assert.equal(entryPath(42), "factory/memory/42.md")
    assert.ok(readFileSync(join(root, entryPath(42)), "utf8").includes("issue: 42"))
  })
})

describe("the checked-in index", () => {
  it("equals what an empty corpus renders, so the first write is not a spurious diff", () => {
    const checkedIn = readFileSync(new URL("../memory/README.md", import.meta.url), "utf8")
    assert.equal(checkedIn, renderIndex([]))
  })
})

describe("dedupe scoring", () => {
  it("scores an overlapping report above an unrelated one", () => {
    const overlapping = score(entry, "CRLF files break edit block matching", "the locator reports no match")
    const unrelated = score(entry, "Add a dark theme to the dashboard", "the colours are hard to read at night")
    assert.ok(overlapping > unrelated, `${String(overlapping)} should exceed ${String(unrelated)}`)
  })

  it("scores an empty query zero rather than dividing by zero", () => {
    assert.equal(score(entry, "", ""), 0)
  })

  it("returns the best candidates first and drops the zeroes", () => {
    const corpus: ReadonlyArray<Entry> = [
      entry,
      { ...entry, issue: 8, title: "Dark theme", summary: "colours" }
    ]
    const found = candidates(corpus, "CRLF edit block locator", "no match reported")
    assert.equal(found[0]?.entry.issue, 42)
    assert.ok(found.every((candidate) => candidate.score > 0))
  })
})
