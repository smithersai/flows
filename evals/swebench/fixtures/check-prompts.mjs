/**
 * Pins the two harnesses' prompts to one another.
 *
 * The rig's whole claim is that a flows number and a codex number on one
 * instance are the same measurement of two harnesses. That claim is only as good
 * as the prompts: anything one side is taught and the other is not is a variable
 * the comparison does not control, and it will show up in the score as if it
 * were harness quality.
 *
 * The rule this pins is not "the two prompts are identical" — they cannot be,
 * because one names flows' own tools — but **the difference is exactly the tool
 * guidance and nothing else**. The flows-only lines are listed here by hand, so
 * adding a sixth one, or dropping a shared line from one side, fails this check
 * rather than quietly moving the baseline.
 *
 * It is written because that is what happened. On 2026-08-19 the flows prompt
 * started naming the repository's own test runner — `./tests/runtests.py` for
 * Django, `tox` for Sphinx — and the codex prompt kept telling its agent to
 * verify with `python -m pytest`, which neither repository can run. Waves 10 and
 * 11 compared a harness that could check its work against a baseline that could
 * not, on two of five instances, and nothing in the rig said so.
 *
 * Spends no tokens, needs no docker, needs no dataset: the instance row is
 * synthesised here.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-prompts-"))

const instance = {
  instance_id: "stub__prompt-1",
  repo: "stub/stub",
  version: "1.0",
  base_commit: "0f1e2d3c4b5a",
  problem_statement: "The reindexer drops the calendar attribute when the axis is empty.",
  // The graded identifiers travel in the dataset row. Neither prompt writer may
  // put them in a prompt, and both are handed the whole row.
  FAIL_TO_PASS: ["tests/test_reindex.py::test_empty_axis_keeps_calendar"],
  PASS_TO_PASS: ["tests/test_reindex.py::test_basic"],
  patch: "--- a/stub/reindex.py\n+++ b/stub/reindex.py\n@@\n-drop\n+keep\n",
  test_patch: "--- a/tests/test_reindex.py\n+++ b/tests/test_reindex.py\n@@\n+def test_empty_axis_keeps_calendar():\n"
}

const container = "flowsbench-stub--prompt-1"
const testCommand = "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1"

const write = (script, args) => {
  const result = spawnSync(process.execPath, [join(root, "lib", script), ...args], { encoding: "utf8" })
  return result
}

try {
  const dataset = join(temporary, "dataset.json")
  writeFileSync(dataset, JSON.stringify([instance]))

  const flowsRun = write("write-flow.mjs", [dataset, instance.instance_id, "openai:gpt-5.6-sol", container, testCommand])
  assert.equal(flowsRun.status, 0, flowsRun.stderr)
  const codexRun = write("write-prompt-codex.mjs", [dataset, instance.instance_id, container, testCommand])
  assert.equal(codexRun.status, 0, codexRun.stderr)

  const flowsPrompt = flowsRun.stdout
  const codexPrompt = codexRun.stdout

  // -------------------------------------------------------------------------
  // Neither prompt carries the answer
  // -------------------------------------------------------------------------
  for (const [name, prompt] of [["flows", flowsPrompt], ["codex", codexPrompt]]) {
    for (const leak of [...instance.FAIL_TO_PASS, ...instance.PASS_TO_PASS, "FAIL_TO_PASS", "PASS_TO_PASS"]) {
      assert.ok(!prompt.includes(leak), `${name} prompt names ${leak}`)
    }
    assert.ok(!prompt.includes("+keep"), `${name} prompt carries the gold patch`)
    assert.ok(!prompt.includes("test_empty_axis_keeps_calendar"), `${name} prompt carries the graded test`)
    assert.ok(prompt.includes(instance.problem_statement), `${name} prompt carries the issue`)
    assert.ok(prompt.includes(instance.base_commit), `${name} prompt names the base commit`)
    assert.ok(prompt.includes(container), `${name} prompt names this run's container`)
  }

  // -------------------------------------------------------------------------
  // The environment teaching is the same teaching
  // -------------------------------------------------------------------------
  const runnerBullet = `- This repository runs its tests with \`${testCommand}\`, which takes the test
  paths to run as trailing arguments. It is the runner this project actually
  uses: other runners are not necessarily installed here.`
  assert.ok(flowsPrompt.includes(runnerBullet), "the flows prompt names the repository's runner")
  assert.ok(codexPrompt.includes(runnerBullet), "the codex prompt names the same runner, byte for byte")

  // The example command is a placeholder on both sides. Spelling a runner into
  // it is how the two drifted apart the first time: the codex prompt's example
  // said `python -m pytest`, which is not the runner for every repository.
  const example = `      docker exec ${container} bash -lc 'cd /testbed && <command>'`
  assert.ok(flowsPrompt.includes(example), "the flows prompt's example is a placeholder")
  assert.ok(codexPrompt.includes(example), "the codex prompt's example is the same placeholder")
  for (const prompt of [flowsPrompt, codexPrompt]) {
    assert.ok(!prompt.includes("python -m pytest"), "no prompt hard-codes one repository's runner")
  }

  // -------------------------------------------------------------------------
  // The difference is the tool guidance, and it is listed
  // -------------------------------------------------------------------------
  //
  // Every line the flows prompt has and the codex prompt does not. Each is
  // either the flows frontmatter, a flows tool, or the Jujutsu colocation the
  // flows CLI creates in its own workspace and the codex workspace never has.
  const flowsOnly = [
    "---",
    "description: Resolve a reported issue in this repository.",
    "model: openai:gpt-5.6-sol",
    "---",
    // The same sentence, wrapped one word differently because the flows side
    // names the `bash` flow where the codex side says "shell".
    "Your `bash` flow runs on a macOS host with BSD userland. The repository's own",
    "Linux environment and Python interpreter are in a container that has this exact",
    "- This checkout is colocated with Jujutsu, which snapshots the working copy, so",
    "  a plain `git diff` prints nothing even when your edits are on disk. To see",
    "  your own changes, diff against the base commit:",
    `      git diff ${instance.base_commit}`,
    "- To change a file, prefer the `write` flow: read the file, and write back the",
    "  complete new contents. That is the most reliable edit available to you.",
    "- `read` and `write` act on this directory directly and need no container.",
    "Complete only when you have applied the fix to the source files and confirmed it",
    "by running code. When you complete, set `output` to a short description of the",
    "change you made."
  ]
  const codexOnly = [
    "Your shell runs on a macOS host with BSD userland. The repository's own Linux",
    "environment and Python interpreter are in a container that has this exact",
    "Finish only when you have applied the fix to the source files and confirmed it",
    "by running code."
  ]

  const lines = (prompt) => prompt.split("\n")
  const missingFrom = (left, right) => {
    const held = new Set(lines(right))
    return lines(left).filter((line) => line.trim() !== "" && !held.has(line))
  }

  assert.deepEqual(
    missingFrom(flowsPrompt, codexPrompt),
    flowsOnly,
    "the flows prompt says nothing the codex prompt does not, beyond flows' own tools"
  )
  assert.deepEqual(
    missingFrom(codexPrompt, flowsPrompt),
    codexOnly,
    "the codex prompt says nothing the flows prompt does not, beyond the same lines reworded"
  )

  // -------------------------------------------------------------------------
  // Neither writer will produce a prompt with no runner in it
  // -------------------------------------------------------------------------
  const flowsBare = write("write-flow.mjs", [dataset, instance.instance_id, "openai:gpt-5.6-sol", container])
  assert.equal(flowsBare.status, 1, "write-flow.mjs refuses a prompt with no test command")
  assert.match(flowsBare.stderr, /no test command given/u)
  const codexBare = write("write-prompt-codex.mjs", [dataset, instance.instance_id, container])
  assert.equal(codexBare.status, 1, "write-prompt-codex.mjs refuses a prompt with no test command")
  assert.match(codexBare.stderr, /no test command given/u)
  const codexBlank = write("write-prompt-codex.mjs", [dataset, instance.instance_id, container, "   "])
  assert.equal(codexBlank.status, 1, "a blank test command is no test command")

  // -------------------------------------------------------------------------
  // The runner reaches the codex prompt from the run script, not by hand
  // -------------------------------------------------------------------------
  const script = spawnSync("grep", ["-c", "lib/test-command.py", join(root, "run-instance-codex.sh")], {
    encoding: "utf8"
  })
  assert.equal(script.status, 0, "run-instance-codex.sh derives the test command from lib/test-command.py")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-prompts.mjs: both harnesses are taught the same environment, and only their own tools differ.")
