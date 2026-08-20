/**
 * Writes the codex-baseline prompt for one instance.
 *
 *   node lib/write-prompt-codex.mjs <dataset.json> <instance_id> <container>
 *
 * Deliberately byte-close to write-flow.mjs: same issue text, same environment
 * explanation, same rules and budget framing. The only removals are
 * flows-specific tool guidance (the `write` flow) — codex brings its own tools,
 * which is exactly the variable this baseline isolates.
 */
import { readFileSync } from "node:fs"

const [, , datasetPath, instanceId, container] = process.argv
const all = JSON.parse(readFileSync(datasetPath, "utf8"))
const instance = all.find((row) => row.instance_id === instanceId)
if (instance === undefined) {
  console.error(`unknown instance ${instanceId}`)
  process.exit(1)
}

const body = `You are working in a checkout of ${instance.repo} at commit ${instance.base_commit}.
The working directory is the repository root.

Resolve the issue below by editing the repository's source files.

## Your environment

Your shell runs on a macOS host with BSD userland. The repository's own Linux
environment and Python interpreter are in a container that has this exact
directory mounted at /testbed, so a file you change here changes there
immediately, and vice versa.

- Run anything that touches the project — imports, scripts, tests — inside the
  container:

      docker exec ${container} bash -lc 'cd /testbed && python -m pytest <path> -x -q'

  GNU grep, GNU sed, and the project's dependencies are all available there.
  \`sed -i\` on the host is BSD sed and will not behave like GNU sed; run it
  through docker exec, or avoid it.

## How to work

Reproduce the problem first, find the responsible code, make the smallest correct
fix in the library source, and verify it by running the relevant existing tests in
the container. Do not modify tests to make them pass, and do not add new test
files. Do not commit; leave your changes in the working tree.

Always check the exit code and output of a command before believing it worked. A
command that exits non-zero did not do what you asked.

Finish only when you have applied the fix to the source files and confirmed it
by running code.

## Issue

${instance.problem_statement}
`

process.stdout.write(body)
