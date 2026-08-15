import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Conformance from "../src/Conformance.ts"
import {
  openCodeBehaviorInventory,
  requiredOpenCodeBehaviors,
  requiredOpenCodeSources,
  rows
} from "../src/ParityManifest.ts"

// Manifest paths are superproject-relative: agent/ is a submodule of the
// flows monorepo alongside flows/ (engine, engine-store, time-travel) and
// reference/ (the OpenCode corpus).
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const testFile = /\.test\.ts$/

describe("ParityManifest", () => {
  it("maps every conformance pin entry to an executable suite case", () => {
    const names = new Set(Conformance.suite().map((conformanceCase) => conformanceCase.name))
    for (const row of rows) {
      if (testFile.test(row.flowsEquivalent) || row.flowsEquivalent === "—") continue
      expect(names.has(row.flowsEquivalent), `${row.source}: ${row.flowsEquivalent}`).toBe(true)
    }
  })

  it("maps every test-file entry to a file in the repository", () => {
    for (const row of rows) {
      if (!testFile.test(row.flowsEquivalent)) continue
      expect(existsSync(new URL(row.flowsEquivalent, `file://${repositoryRoot}/`)), row.flowsEquivalent).toBe(true)
    }
  })

  it("explains every incomplete parity claim", () => {
    for (const row of rows) {
      if (row.status === "pinned") continue
      expect(row.reason?.trim(), `${row.source}: ${row.behavior}`).toBeTruthy()
    }
  })

  it("does not duplicate external behavior claims", () => {
    const claims = rows.map((row) => `${row.source}\u0000${row.behavior}`)
    expect(new Set(claims).size).toBe(claims.length)
  })

  it("accounts for every ranked Smithers conformance row", () => {
    const ranks = new Set(
      rows.flatMap((row) => {
        const match = /^smithers #(\d+)\b/.exec(row.source)
        return match === null ? [] : [Number(match[1])]
      })
    )
    expect([...ranks].filter((rank) => rank >= 1 && rank <= 14).sort((left, right) => left - right)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14
    ])
  })

  it("accounts for every targeted OpenCode session source", () => {
    const sourceDirectory = new URL(
      "reference/opencode/packages/core/test/",
      `file://${repositoryRoot}/`
    )
    const discovered = readdirSync(sourceDirectory)
      .filter((name) =>
        /^session-(?:runner.*|tool-progress|create|prompt|projector|compaction|todo|run-coordinator|history)\.test\.ts$/
          .test(
            name
          )
      )
      .map((name) => `packages/core/test/${name}`)
      .sort()
    expect([...requiredOpenCodeSources].sort()).toEqual(discovered)
  })

  it("inventories every static behavior in each targeted OpenCode source", () => {
    for (const source of requiredOpenCodeSources) {
      const text = readFileSync(
        new URL(`reference/opencode/${source}`, `file://${repositoryRoot}/`),
        "utf8"
      )
      const discovered = [
        ...new Set(
          [...text.matchAll(/\b(?:test|it)(?:\.effect)?\(\s*(["'`])((?:(?!\1)[\s\S])*?)\1/g)].map(
            (match) => (match[2] ?? "").replace(/\s+/g, " ").trim()
          )
        )
      ].sort()
      expect(
        [...openCodeBehaviorInventory[source as keyof typeof openCodeBehaviorInventory]].sort(),
        source
      ).toEqual(discovered)
    }
  })

  it("maps every targeted OpenCode behavior", () => {
    for (const { source, behavior } of requiredOpenCodeBehaviors) {
      expect(
        rows.some((row) => row.source === source && row.behavior === behavior),
        `missing OpenCode parity row for ${source}: ${behavior}`
      ).toBe(true)
    }
  })

  it("classifies heartbeat fencing and exact harness descendants without overclaiming durability", () => {
    const heartbeat = rows.find((row) => row.source.startsWith("smithers #5 "))
    expect(heartbeat).toMatchObject({
      flowsEquivalent: "flows/packages/engine-store/test/Ownership.test.ts",
      status: "partial"
    })

    const expected = [
      ["forces one compaction and retries after provider context overflow", "pinned"],
      ["persists a second context overflow after one recovery", "partial"],
      ["recovers once from a raw context overflow failure", "pinned"],
      ["does not recover context overflow after durable assistant output", "partial"],
      ["forces a text response on an agent's configured final step", "pinned"],
      ["projects raw provider stream failures as terminal assistant step failures", "partial"],
      ["keeps interleaved assistant text blocks separate", "pinned"],
      ["broadcasts provider ${kind} deltas without storing projection rewrites", "partial"],
      ["durably closes partial ${kind} when the provider stream fails", "partial"],
      ["durably closes partial ${kind} when the provider stream is interrupted", "partial"]
    ] as const
    for (const [behavior, status] of expected) {
      expect(
        rows.find((row) =>
          row.source === "packages/core/test/session-runner.test.ts" &&
          row.behavior === behavior
        ),
        behavior
      ).toMatchObject({ status })
    }
  })
})
