import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-rig-"))

try {
  const dataset = join(temporary, "dataset.json")
  writeFileSync(dataset, JSON.stringify([{
    instance_id: "django__django-1",
    repo: "django/django",
    version: "4.1",
    base_commit: "abc123",
    problem_statement: "Fix the redirect."
  }]))

  const generated = spawnSync(
    process.execPath,
    [
      join(root, "lib/write-flow.mjs"),
      dataset,
      "django__django-1",
      "openai:test",
      "test-container",
      "./tests/runtests.py --verbosity 2"
    ],
    { encoding: "utf8" }
  )
  assert.equal(generated.status, 0, generated.stderr)
  assert.match(generated.stdout, /\.\/tests\/runtests\.py --verbosity 2/)
  assert.match(generated.stdout, /git diff abc123/)
  assert.doesNotMatch(generated.stdout, /FAIL_TO_PASS|PASS_TO_PASS/)

  const missing = spawnSync(
    process.execPath,
    [join(root, "lib/write-flow.mjs"), dataset, "django__django-1", "openai:test", "test-container"],
    { encoding: "utf8" }
  )
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /no test command given/)

  const valid = spawnSync(process.execPath, [join(root, "lib/validate-instance.mjs"), dataset, "django__django-1"], {
    encoding: "utf8"
  })
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(valid.stdout, "abc123")

  const traversal = spawnSync(join(root, "run-instance.sh"), ["../escape"], {
    encoding: "utf8",
    env: { ...process.env, SWB_DATASET: dataset }
  })
  assert.equal(traversal.status, 2)
  assert.match(traversal.stderr, /instance id must match/)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-rig.mjs: repository test runner and base-diff guidance are pinned.")
