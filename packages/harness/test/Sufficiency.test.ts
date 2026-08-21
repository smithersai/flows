/**
 * The one control that is not a brake.
 *
 * The cases fix three things, in the order the module cares about them: what
 * counts as half of the evidence, what counts as the other half, and what the
 * ordering between them has to be. The last is where a signal like this goes
 * wrong — a pair read off the wrong side of an edit reports a run's own
 * baseline back to it as proof — so the frame that also mutated is tested from
 * both ends.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as Sufficiency from "../src/Sufficiency.ts"

const command = (text: string): Schema.Json => ({ mode: "unhermetic", command: text })

const ran = (
  text: string,
  options: {
    readonly failing?: boolean | undefined
    readonly passing?: boolean | undefined
    readonly stable?: boolean | undefined
  } = {}
): NarrowedCheck.Check => {
  const input = command(text)
  const recorded = NarrowedCheck.check({
    flow: "bash",
    signature: `bash:${JSON.stringify(input)}`,
    input,
    digest: "tree",
    failing: options.failing ?? false,
    passing: options.passing ?? false,
    stable: options.stable ?? true
  })
  if (recorded === undefined) throw new Error("the fixture input is not a check")
  return recorded
}

const failedAt = (text: string, epoch: number): Sufficiency.Ledger =>
  Sufficiency.remember([], { frame: [ran(text, { failing: true })], epoch })

describe("Sufficiency.remember", () => {
  it("records a failing check against the epoch it failed in", () => {
    const ledger = failedAt("check a/b.py", 0)

    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.epoch).toBe(0)
    expect(ledger[0]?.flow).toBe("bash")
    expect(ledger[0]?.label).toContain("check a/b.py")
  })

  it("records nothing for a check that reported no failure", () => {
    expect(Sufficiency.remember([], { frame: [ran("check a/b.py", { passing: true })], epoch: 0 })).toEqual([])
  })

  it("drops a failure watched in a frame that also changed the workspace", () => {
    // A frame's calls are not ordered against its edits in anything the harness
    // records, so this check might have failed before the change or after it —
    // and a failure stamped on the wrong side of an edit is the false
    // before-and-after this module exists to never manufacture.
    expect(
      Sufficiency.remember([], { frame: [ran("check a/b.py", { failing: true, stable: false })], epoch: 0 })
    ).toEqual([])
  })

  it("restamps a check that failed again over a later epoch", () => {
    const first = failedAt("check a/b.py", 0)
    const other = Sufficiency.remember(first, { frame: [ran("check c/d.py", { failing: true })], epoch: 0 })
    const again = Sufficiency.remember(other, { frame: [ran("check a/b.py", { failing: true })], epoch: 1 })

    expect(again.map((entry) => entry.epoch)).toEqual([0, 1])
    expect(again[1]?.label).toContain("check a/b.py")
  })

  it("forgets its oldest failures first once the bound is reached", () => {
    const many = Array.from(
      { length: Sufficiency.retained + 2 },
      (_, index) => ran(`check ${index}`, { failing: true })
    )

    const ledger = Sufficiency.remember([], { frame: many, epoch: 0 })

    expect(ledger).toHaveLength(Sufficiency.retained)
    expect(ledger[0]?.label).toContain("check 2")
  })
})

describe("Sufficiency.find", () => {
  it("names the pair when the same check failed before the change and passed after", () => {
    const found = Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })

    expect(found?.failed.label).toContain("check a/b.py")
    expect(found?.passed.label).toContain("check a/b.py")
  })

  it("accepts a broader check passing than the one that failed", () => {
    // A broader reading passing is stronger evidence than the narrow one
    // passing, never weaker, so it is admitted as the other half.
    const found = Sufficiency.find({
      ledger: failedAt("check a/b.py -k one", 0),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })

    expect(found?.failed.label).toContain("-k one")
    expect(found?.passed.label).not.toContain("-k one")
  })

  it("says nothing when the passing check asks about something else", () => {
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check c/d.py", { passing: true })],
      epoch: 1
    })).toBeUndefined()
  })

  it("says nothing when the check that answers reported no exit status at all", () => {
    // Silence is not a pass. Without this a file read would be half of a
    // completion signal, which is the shape of every hollow completion the
    // other controls exist to catch.
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py")],
      epoch: 1
    })).toBeUndefined()
  })

  it("says nothing while nothing has changed since the check failed", () => {
    expect(Sufficiency.find({
      ledger: failedAt("check a/b.py", 1),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })).toBeUndefined()
  })

  it("says nothing when the run has watched nothing fail", () => {
    expect(Sufficiency.find({ ledger: [], frame: [ran("check a/b.py", { passing: true })], epoch: 1 }))
      .toBeUndefined()
  })

  it("quotes the broadest passing check rather than the first one it finds", () => {
    const ledger = failedAt("check a/b.py -k one", 0)
    const narrow = ran("check a/b.py -k one", { passing: true })
    const broad = ran("check a/b.py", { passing: true })

    expect(Sufficiency.find({ ledger, frame: [narrow, broad], epoch: 1 })?.passed.label).toBe(broad.label)
    expect(Sufficiency.find({ ledger, frame: [broad, narrow], epoch: 1 })?.passed.label).toBe(broad.label)
  })

  it("quotes the most recent failure the passing check answers", () => {
    const older = failedAt("check a/b.py -k one", 0)
    const ledger = Sufficiency.remember(older, {
      frame: [ran("check a/b.py -k two", { failing: true })],
      epoch: 0
    })

    expect(Sufficiency.find({ ledger, frame: [ran("check a/b.py", { passing: true })], epoch: 1 })?.failed.label)
      .toContain("-k two")
  })
})

describe("Sufficiency.observation", () => {
  it("quotes both readings, asks for nothing, and says it is written once", () => {
    const found = Sufficiency.find({
      ledger: failedAt("check a/b.py", 0),
      frame: [ran("check a/b.py", { passing: true })],
      epoch: 1
    })
    const text = Sufficiency.observation(found!)

    expect(text).toContain("check a/b.py")
    expect(text).toContain("failed, before the workspace changed")
    expect(text).toContain("passed, after it changed")
    // The whole point of the counterweight: it is not a demand, and it says so
    // in the same breath as it names the two things the run may do next.
    expect(text).toContain("Nothing is being asked of you and nothing has been refused")
    expect(text).toContain("complete now")
    expect(text).toContain("which reading is still missing")
    expect(text).toContain("written once per run")
  })
})

describe("Sufficiency.Ledger", () => {
  it("decodes an absent ledger as an empty one", () => {
    const Holder = Schema.Struct({ failures: Sufficiency.Ledger })

    expect(Effect.runSync(Schema.decodeUnknownEffect(Holder)({}))).toEqual({ failures: [] })
  })
})
