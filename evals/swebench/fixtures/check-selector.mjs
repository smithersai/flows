/**
 * Replays the journal-only candidate selector over two real waves.
 *
 * `select-candidate.mjs` decides which of an instance's n runs is submitted, and
 * it decides it before anything is graded. Two things therefore have to be true
 * of it and are checked here: it reads the four predicates off a journal the way
 * the harness's own detectors read them, and it is deterministic — the same
 * journals choose the same run, every time, on any machine.
 *
 * The candidates are not synthesised. Wave 10 and wave 11 ran the same five
 * instances, both waves' journals were distilled at the time
 * (`packages/harness/test/fixtures/wave10Journals.json` and
 * `fixtures/wave11-journals.json`), and `fixtures/rehydrate-journals.mjs` turns
 * a distillation back into the database the selector reads. So the
 * two-candidate case below is two real runs of one instance, and the numbers
 * pinned here are what those runs did.
 *
 * Four synthetic candidates are added at the end, and only to reach the
 * tie-breaks: two waves that disagree about a predicate never exercise what
 * happens when they agree about all four.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-selector-"))

const instances = [
  "astropy__astropy-8707",
  "django__django-16612",
  "pydata__xarray-7393",
  "pytest-dev__pytest-6197",
  "sphinx-doc__sphinx-11445"
]

const rehydrate = (source, out, index, patches) => {
  const result = spawnSync(
    process.execPath,
    [join(root, "fixtures/rehydrate-journals.mjs"), source, out, index, patches],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 0, result.stderr)
}

const select = (instance, journals, patches, out, extra = []) =>
  spawnSync(
    process.execPath,
    [join(root, "select-candidate.mjs"), instance, "--journals", journals, "--patches", patches, "--out", out, ...extra],
    { encoding: "utf8" }
  )

const rationaleOf = (out, instance) => readFileSync(join(out, `${instance}.rationale.json`), "utf8")

try {
  const journals = join(temporary, "journals")
  const patches = join(temporary, "patches")
  const out = join(temporary, "selected")

  // -----------------------------------------------------------------------
  // One candidate: the choice is that candidate, and its predicates are the
  // ones wave 11 actually earned.
  // -----------------------------------------------------------------------
  rehydrate(join(root, "fixtures/wave11-journals.json"), journals, "r1", patches)

  /** What wave 11's five runs hold, as the four predicates read them. */
  const waveEleven = {
    "astropy__astropy-8707": [true, true, false, true],
    "django__django-16612": [true, true, false, true],
    "pydata__xarray-7393": [true, false, false, false],
    "pytest-dev__pytest-6197": [true, true, true, true],
    "sphinx-doc__sphinx-11445": [true, true, true, true]
  }

  for (const instance of instances) {
    const run = select(instance, journals, patches, out)
    assert.equal(run.status, 0, run.stderr)
    const rationale = JSON.parse(rationaleOf(out, instance))
    assert.equal(rationale.selected, "r1", `${instance}: one candidate is the choice`)
    assert.equal(rationale.candidates.length, 1)
    const [candidate] = rationale.candidates
    assert.deepEqual(
      [
        candidate.predicates.preEditFailure.held,
        candidate.predicates.mutationAfter.held,
        candidate.predicates.greenOverFinalTree.held,
        candidate.predicates.cleanCompletion.held
      ],
      waveEleven[instance],
      `${instance}: wave 11's predicates`
    )
    assert.equal(candidate.score, waveEleven[instance].filter(Boolean).length)
    // Every predicate that holds names the journal event it was read from.
    for (const [name, predicate] of Object.entries(candidate.predicates)) {
      if (predicate.held) {
        assert.equal(typeof predicate.seq, "number", `${instance}: ${name} names its evidence`)
      } else {
        assert.equal(typeof predicate.why, "string", `${instance}: ${name} says why not`)
      }
    }
  }

  // The run that changed nothing is the run that holds the least. Wave 11's
  // xarray issued 24 frames, never moved the tree and never completed.
  const xarray = JSON.parse(rationaleOf(out, "pydata__xarray-7393")).candidates[0]
  assert.equal(xarray.score, 1)
  assert.equal(xarray.predicates.cleanCompletion.held, false)
  assert.match(xarray.predicates.cleanCompletion.why, /never applied a complete transition/)

  // -----------------------------------------------------------------------
  // Two candidates: wave 10 as r2 beside wave 11 as r1, and the choice each
  // instance's two real runs produce.
  // -----------------------------------------------------------------------
  rehydrate(join(root, "../../packages/harness/test/fixtures/wave10Journals.json"), journals, "r2", patches)

  /**
   * What the two waves choose, and which key decides it.
   *
   * `score` picks three of the five. The other two agree on all four predicates
   * and are separated by the first tie-break: the broader final check, which is
   * the one with fewer terms.
   */
  const chosen = {
    "astropy__astropy-8707": { index: "r2", by: "score", scores: { r1: 3, r2: 4 } },
    "django__django-16612": { index: "r1", by: "score", scores: { r1: 3, r2: 1 } },
    "pydata__xarray-7393": { index: "r1", by: "run index", scores: { r1: 1, r2: 1 } },
    "pytest-dev__pytest-6197": { index: "r2", by: "terms", scores: { r1: 4, r2: 4 }, terms: { r1: 35, r2: 34 } },
    "sphinx-doc__sphinx-11445": { index: "r2", by: "terms", scores: { r1: 4, r2: 4 }, terms: { r1: 122, r2: 53 } }
  }

  for (const instance of instances) {
    const run = select(instance, journals, patches, out)
    assert.equal(run.status, 0, run.stderr)
    const rationale = JSON.parse(rationaleOf(out, instance))
    const expected = chosen[instance]
    assert.equal(rationale.candidates.length, 2, `${instance}: two candidates`)
    assert.equal(rationale.selected, expected.index, `${instance}: chosen by ${expected.by}`)
    assert.equal(rationale.candidates[0].index, expected.index, "the chosen candidate ranks first")
    for (const candidate of rationale.candidates) {
      assert.equal(candidate.score, expected.scores[candidate.index], `${instance} ${candidate.index}: score`)
      if (expected.terms !== undefined) {
        assert.equal(candidate.finalCheckTerms, expected.terms[candidate.index], `${instance} ${candidate.index}: terms`)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Determinism: the same journals, twice, byte for byte.
  // -----------------------------------------------------------------------
  const first = instances.map((instance) => rationaleOf(out, instance))
  for (const instance of instances) {
    const run = select(instance, journals, patches, out)
    assert.equal(run.status, 0, run.stderr)
  }
  instances.forEach((instance, position) => {
    assert.equal(rationaleOf(out, instance), first[position], `${instance}: the selection is deterministic`)
  })

  // The selected patch is the chosen run's patch, byte for byte.
  for (const instance of instances) {
    const rationale = JSON.parse(rationaleOf(out, instance))
    assert.equal(
      readFileSync(join(out, `${instance}.patch`), "utf8"),
      readFileSync(join(patches, `${instance}-${rationale.selected}.patch`), "utf8")
    )
  }

  // -----------------------------------------------------------------------
  // The tie-breaks below the first one, which two real waves never reach.
  // -----------------------------------------------------------------------
  const twin = (instance, patchBytes, usage) => ({
    instance,
    openedOn: "aaaa",
    patchBytes,
    usage,
    frames: [
      {
        calls: [{ flow: "bash", input: { command: "check tests/a.py" }, ok: true, mutates: false, exit: 1 }],
        basis: "observed",
        digest: "aaaa",
        mutated: false,
        transition: "continue"
      },
      {
        calls: [{ flow: "write", input: { path: "a.py", text: "x" }, ok: true, mutates: true }],
        basis: "observed",
        digest: "bbbb",
        mutated: true,
        transition: "continue"
      },
      {
        calls: [{ flow: "bash", input: { command: "check tests/a.py" }, ok: true, mutates: false, exit: 0 }],
        basis: "observed",
        digest: "bbbb",
        mutated: false,
        transition: "complete"
      }
    ]
  })

  const tieJournals = join(temporary, "tie-journals")
  const tiePatches = join(temporary, "tie-patches")
  const tieOut = join(temporary, "tie-selected")
  mkdirSync(join(temporary, "tie"), { recursive: true })
  const cost = { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 10_000 }
  const cheaper = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 1_000 }

  // r1 changed nothing worth capturing, r2 did: a non-empty patch wins.
  writeFileSync(
    join(temporary, "tie", "r1.json"),
    JSON.stringify({ journals: [twin("tie__patch", 0, cost), twin("tie__cost", 40, cost)] })
  )
  writeFileSync(
    join(temporary, "tie", "r2.json"),
    JSON.stringify({ journals: [twin("tie__patch", 40, cost), twin("tie__cost", 40, cheaper)] })
  )
  rehydrate(join(temporary, "tie", "r1.json"), tieJournals, "r1", tiePatches)
  rehydrate(join(temporary, "tie", "r2.json"), tieJournals, "r2", tiePatches)

  for (const instance of ["tie__patch", "tie__cost"]) {
    const run = select(instance, tieJournals, tiePatches, tieOut)
    assert.equal(run.status, 0, run.stderr)
    const rationale = JSON.parse(rationaleOf(tieOut, instance))
    assert.deepEqual(rationale.candidates.map((candidate) => candidate.score), [4, 4], `${instance}: the scores tie`)
    assert.deepEqual(
      rationale.candidates.map((candidate) => candidate.finalCheckTerms),
      [3, 3],
      `${instance}: the final checks tie`
    )
    assert.equal(rationale.selected, "r2", `${instance}: the later run wins on the tie-break alone`)
  }
  assert.equal(JSON.parse(rationaleOf(tieOut, "tie__patch")).candidates[1].patchBytes, 0)
  assert.ok(
    JSON.parse(rationaleOf(tieOut, "tie__cost")).candidates[0].usd
      < JSON.parse(rationaleOf(tieOut, "tie__cost")).candidates[1].usd,
    "the cheaper run wins when everything above cost ties"
  )

  // -----------------------------------------------------------------------
  // What it refuses. The selector may only ever name a journal or a patch.
  // -----------------------------------------------------------------------
  const unknown = select(instances[0], journals, patches, out, ["--report", join(root, "flows-cell-harness.w11.json")])
  assert.equal(unknown.status, 2, "an unknown flag is refused, not ignored")
  assert.match(unknown.stderr, /unknown flag --report/)
  assert.match(unknown.stderr, /reads no evaluator report/)

  const asFile = select(instances[0], join(root, "prices.ts"), patches, out)
  assert.equal(asFile.status, 2, "--journals must name a directory")
  assert.match(asFile.stderr, /must name a directory/)

  const missing = select("nothing__here", journals, patches, out)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no archived journal/)

  const twoIds = spawnSync(
    process.execPath,
    [join(root, "select-candidate.mjs"), instances[0], instances[1], "--journals", journals],
    { encoding: "utf8" }
  )
  assert.equal(twoIds.status, 2, "one instance at a time")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-selector.mjs: two real waves rank as recorded, and the selection is deterministic.")
