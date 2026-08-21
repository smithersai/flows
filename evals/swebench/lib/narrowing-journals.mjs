/**
 * Distils a wave's journals into the fixture the narrowing detector replays.
 *
 *   node lib/narrowing-journals.mjs [work-dir] [out-file]
 *
 * The detector in `@smthrs/harness` `NarrowedCheck` reads four things off a
 * run: the flow and input of every settled call, whether that call succeeded,
 * whether it declared a write, and the workspace digest each frame closed on.
 * This writes exactly those, per frame, for every instance in a wave's work
 * directory, so the harness suite can replay a real wave without a database and
 * without the 12 MB of journals that produced it.
 *
 * Defaults write `packages/harness/test/fixtures/narrowingJournals.json`, which
 * is committed: it is the evidence the demand was designed against, and a
 * change to the detector that starts demanding something of the four resolved
 * instances has to explain itself against this file rather than against a
 * memory of what a wave once did.
 *
 * `declaredWrites` is per frame rather than per call in the journal, so a call
 * is marked as declaring a write only when its flow is one the wave's own
 * report classes as an edit — the same list `fixtures/make-fixture.mjs` uses.
 * The detector only ever uses the flag to *skip* an entry, so a
 * misclassification here can suppress a demand and cannot invent one.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const work = resolve(process.argv[2] ?? join(here, "..", "work"))
const out = resolve(
  process.argv[3] ?? join(here, "..", "..", "..", "packages", "harness", "test", "fixtures", "narrowingJournals.json")
)

/** Flows whose calls change the workspace, so they are never checks. */
const editing = new Set(["write", "edit", "apply_patch"])

const distil = (path) => {
  const db = new DatabaseSync(path, { readOnly: true })
  const rows = db.prepare(
    "select seq, event_type, payload_json from flows_journal_events"
      + " where event_type like 'control.agent.%' order by seq"
  ).all()
  const frames = []
  const started = []
  let frame
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    switch (row.event_type) {
      case "control.agent.turn-opened":
        frame = { calls: [], basis: "declared", digest: "", transition: "none", seq: row.seq }
        frames.push(frame)
        break
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        frame.calls.push({
          flow: payload.flowName,
          input: opened.input,
          ok: payload.outcome === "success",
          mutates: editing.has(payload.flowName),
          seq: row.seq
        })
        break
      }
      case "control.agent.mutation-observed":
        frame.basis = payload.basis
        frame.digest = payload.digest
        break
      case "control.agent.transition-applied":
        frame.transition = payload.transition._tag
        frame.transitionSeq = row.seq
        break
      default:
        break
    }
  }
  return frames
}

const instances = readdirSync(work).filter((name) => existsSync(join(work, name, ".flows", "engine.db"))).sort()
const journals = instances.map((instance) => ({ instance, frames: distil(join(work, instance, ".flows", "engine.db")) }))
writeFileSync(out, `${JSON.stringify({ journals }, null, 2)}\n`)
for (const journal of journals) {
  const calls = journal.frames.reduce((total, frame) => total + frame.calls.length, 0)
  console.log(`${journal.instance}: ${journal.frames.length} frames, ${calls} calls`)
}
console.log(`wrote ${out}`)
