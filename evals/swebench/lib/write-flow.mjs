/**
 * Writes the fix flow the built-in harness runs on one instance.
 *
 *   node lib/write-flow.mjs <dataset.json> <instance_id> <seat> <container> <test-command>
 *
 * Ported from the 2026-08 benchmark rig; the dataset is addressed by path
 * instead of by a flat scratch directory, and the repository's test command is
 * supplied by the caller (see lib/test-command.py) instead of assumed to be
 * pytest.
 */
import { readFileSync } from "node:fs"

const [, , datasetPath, instanceId, seat, container, testCommand] = process.argv
if (testCommand === undefined || testCommand.trim() === "") {
  console.error("write-flow.mjs: no test command given; see lib/test-command.py")
  process.exit(1)
}
const all = JSON.parse(readFileSync(datasetPath, "utf8"))
const instance = all.find((row) => row.instance_id === instanceId)
if (instance === undefined) {
  console.error(`unknown instance ${instanceId}`)
  process.exit(1)
}

// The frontmatter body is the agent's whole task. Nothing here reveals the
// gold patch, the test patch, or which tests the grader runs — only the issue
// text a maintainer would have, plus how to run this repo's interpreter.
const body = `---
description: Resolve a reported issue in this repository.
model: ${seat}
---
You are working in a checkout of ${instance.repo} at commit ${instance.base_commit}.
The working directory is the repository root.

Resolve the issue below by editing the repository's source files.

## Your environment

Your \`bash\` flow runs on a macOS host with BSD userland. The repository's own
Linux environment and Python interpreter are in a container that has this exact
directory mounted at /testbed, so a file you change here changes there
immediately, and vice versa.

- Run anything that touches the project — imports, scripts, tests — inside the
  container:

      docker exec ${container} bash -lc 'cd /testbed && <command>'

  GNU grep, GNU sed, and the project's dependencies are all available there.
  \`sed -i\` on the host is BSD sed and will not behave like GNU sed; run it
  through docker exec, or avoid it.
- This repository runs its tests with \`${testCommand}\`, which takes the test
  paths to run as trailing arguments. It is the runner this project actually
  uses: other runners are not necessarily installed here.
- This checkout is colocated with Jujutsu, which snapshots the working copy, so
  a plain \`git diff\` prints nothing even when your edits are on disk. To see
  your own changes, diff against the base commit:

      git diff ${instance.base_commit}
- To change a file, prefer the \`write\` flow: read the file, and write back the
  complete new contents. That is the most reliable edit available to you.
- \`read\` and \`write\` act on this directory directly and need no container.

## How to work

Reproduce the problem first, find the responsible code, make the smallest correct
fix in the library source, and verify it by running the relevant existing tests in
the container. Do not modify tests to make them pass, and do not add new test
files. Do not commit; leave your changes in the working tree.

Always check the exit code and output of a command before believing it worked. A
command that exits non-zero did not do what you asked.

Complete only when you have applied the fix to the source files and confirmed it
by running code. When you complete, set \`output\` to a short description of the
change you made.

## Issue

${instance.problem_statement}
`

process.stdout.write(body)
