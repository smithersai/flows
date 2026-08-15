# GithubCiGen

Verifies an existing GitHub Actions workflow, or explicitly renders one from
declared jobs. The default is a non-mutating structural contract.

```ts
import { GithubCiGen } from "tsflows-rules"

export const ci = GithubCiGen({
  workflowName: "CI",
  pattern: "//...",
  kinds: ["build", "test", "lint"],
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  cancelInProgress: true,
  install: "pnpm install --frozen-lockfile",
  jobs: [],
  requiredJobs: ["test", "rust", "browser"],
  gates: [
    { name: "typecheck", command: "pnpm run check", job: "test" },
    { name: "rust tests", command: "cargo test --locked", job: "rust" }
  ],
  output: ".github/workflows/ci.yml",
  mode: "contract"
})
```

## Modes

| Mode       | Behavior                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `contract` | Default. Parses the checked-in workflow and fails with `DriftError` if a required job or gate is absent. It never writes. |
| `check`    | Renders declared jobs and byte-compares the result with the checked-in workflow. It never writes.                         |
| `write`    | Explicit generation. Validates and writes the rendered workflow.                                                          |

The `lint` form maps `write` to `check`. `tsflows ci` plans lint first, so CI is
also non-mutating even if a target explicitly declares write mode. Only an
explicit `tsflows build` of a `mode: "write"` target generates a file.

## Attributes

| Name               | Type                               | Default                          | Description                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflowName`     | `string`                           | `"CI"`                           | Generated workflow name.                                                                                                                                                                                                                                                 |
| `pattern`          | `string`                           | `"//..."`                        | Pattern executed by the generated tsflows step. Must be `//...`, `//pkg/...`, `//pkg`, `//pkg:target`, or `//:target`; rendered as one single-quoted shell word.                                                                                                         |
| `kinds`            | `Array<Rule.Kind>`                 | build, test, lint                | Verbs emitted by generation, restricted to the ones the CLI has a command for: `build`, `test`, `lint`, `docs`. The complete default set emits one `tsflows ci` command.                                                                                                 |
| `pushBranches`     | `Array<string>`                    | `["main"]`                       | Generated push branches.                                                                                                                                                                                                                                                 |
| `pullRequest`      | `boolean`                          | `true`                           | Generated pull-request trigger.                                                                                                                                                                                                                                          |
| `workflowDispatch` | `boolean`                          | `true`                           | Generated manual trigger.                                                                                                                                                                                                                                                |
| `cancelInProgress` | `boolean`                          | `true`                           | Generated concurrency policy.                                                                                                                                                                                                                                            |
| `install`          | `string`                           | `pnpm install --frozen-lockfile` | Lockfile-respecting install command. Unsupported commands, and flags that can omit a pinned dependency, are rejected; the job that runs tsflows must run an install line that passes the same policy. It also selects the workspace-binary runner of the generated step. |
| `cacheUrlSecret`   | `string`                           | optional                         | Secret supplying `TSFLOWS_CACHE_URL`.                                                                                                                                                                                                                                    |
| `cacheTokenSecret` | `string`                           | optional                         | Secret supplying a remote-cache token.                                                                                                                                                                                                                                   |
| `cacheTokenEnv`    | `string`                           | `TSFLOWS_CACHE_TOKEN`            | Environment variable receiving that token.                                                                                                                                                                                                                               |
| `jobs`             | `Array<Job>`                       | `[]`                             | Jobs rendered by `write` and `check`; may be empty in contract mode. A job's optional `timeoutMinutes` must be a whole number from 1 to 360.                                                                                                                             |
| `gates`            | `Array<Gate>`                      | `[]`                             | Named commands an unconditional step must still run, or actions it must still use, optionally in one job.                                                                                                                                                                |
| `requiredJobs`     | `Array<string>`                    | `[]`                             | Job ids the workflow must define **and run unconditionally**, in every mode.                                                                                                                                                                                             |
| `output`           | `string`                           | `".github/workflows/ci.yml"`     | Workspace-relative workflow path.                                                                                                                                                                                                                                        |
| `mode`             | `"contract" \| "check" \| "write"` | `"contract"`                     | Output handling described above.                                                                                                                                                                                                                                         |

## Contract and generation guarantees

Contract mode preserves a hand-written production pipeline, including comments,
platform lanes, matrices, and advisory jobs, while making required gates
machine-checkable. The parser reads job ids, every `run` and `uses` command, and
the `if:` and `continue-on-error:` of every job and step,
including sequences written at their key's own indentation (`steps:` and
`needs:` in the common compact style), and rejects a duplicate mapping key at every level it reads — a repeated
top-level key, job id, job field, or step field. YAML shadows all of them and
keeps the last, so a gate could otherwise match a job, a `steps:` block, or a
`run:` script GitHub never executes. A key is read unquoted, so `"test":` and
`test:` are the same job id, both to a gate and to the duplicate check. A
missing file, malformed workflow, missing job, or missing/wrong-job gate is a
typed `DriftError` carrying the workflow path.

Quoted scalar values are decoded before shell scanning. JSON-compatible
double-quoted escapes and YAML's doubled-single-quote form are supported;
other YAML-only escape forms are refused. The scanner therefore never treats
the source spelling of an escape as a different shell program and invents a
gate outside a quote that GitHub actually places inside it.

The contract reader admits only a regular, non-symlink workflow file of at
most 1 MiB. It opens nonblocking and no-follow where the host supports those
flags, verifies the opened descriptor against the file it inspected, performs
a bounded read even if the file grows, and rejects invalid UTF-8. A FIFO,
device, socket, symlink, path escape, or oversized file therefore fails the
contract instead of hanging the check or turning it into an unbounded read.

### What a required job proves

A `requiredJobs` entry asserts that the job RUNS, on the same terms as a gate.
A job that carries an `if:` is one GitHub may skip, so only an unconditional job
(or one whose condition is the literal `true` / `${{ true }}`) satisfies the
entry. A job that exists but is conditional is reported as `id (conditional)`
rather than as missing, because the id is right there in the file.
`continue-on-error` is left advisory here for the same reason it is left
advisory for gates.

### What a gate proves

Gate matching is fail-closed, and it is not a substring search.

A gate whose `command` is a shell command is satisfied only when that command
begins where the shell would start reading a command — the beginning of a `run`
script, or after `\n`, `;`, `&`, `&&`, `|`, `||`, a subshell or
command-substitution `(`, a `NAME=value` prefix, or one of the
`if`/`then`/`else`/`elif`/`while`/`until`/`do`/`{`/`}`/`!`/`time`/`sudo`/`exec`
words that introduce one — outside every quoted string, and ends at a shell word
boundary. So these do **not** satisfy a `pnpm run check` gate:

| Script                                   | Why it does not count                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| `echo pnpm run check`                    | the command is an argument; nothing typechecks        |
| `echo "first; pnpm run check"`           | quoted data, separators included                      |
| `# pnpm run check`                       | a shell comment runs nothing                          |
| `pnpm run checkall`                      | a different, longer command name                      |
| `xpnpm run check`                        | a different command name                              |
| `cat <<'EOF'` … `pnpm run check` … `EOF` | a here-document body is data                          |
| `check() { pnpm run check; }`            | declaring a function defers its body; it runs nothing |

Literal (`|`) scripts preserve their line breaks. Folded (`>`) scripts are
read conservatively with physical lines joined as spaces. YAML preserves a few
of those breaks around blank or more-indented lines, but the conservative form
can only report a gate missing; it cannot invent a shell command boundary and
false-pass a gate.

And these do: `pnpm run check`, `pnpm install --frozen-lockfile --ignore-scripts`
(arguments and flags may follow), `if ! cmp a b; then`,
`(cd pkg && bun vitest.mjs run)`, any line of a multiline script, and the
command after a `&& \` line continuation, which the shell joins into one line.

A gate whose `command` names an action matches a `uses` value exactly, or the
same action at any version (`actions/checkout` matches `actions/checkout@v4`).
`evil-org/actions/checkout@v4` does not satisfy an `actions/checkout@v4` gate.

A gate is satisfied only by an **unconditional** job and step. A job or step
carrying an `if:` may be skipped, so it cannot prove a required gate; only the
literal `true` (and `${{ true }}`) is accepted as always-true. `continue-on-error`
is deliberately left advisory: a gate asserts that a command still _runs_, not
that its failure blocks a merge, and the advisory macOS and Windows lanes of a
real pipeline are exactly what a platform-pinned gate exists to pin.

Constructs the scanner does not model (backticks, `eval`) produce no command
start at all, which reports the gate missing rather than accepting text that may
never run.

### What generation refuses

- an empty job list, an empty `kinds` list, and any declared `requiredJobs` id
  the render does not define;
- an install command that is not one of `pnpm install --frozen-lockfile`,
  `npm ci`, `yarn install --immutable`, or `bun install --frozen-lockfile`,
  **or** that carries a flag outside that package manager's allowlist. The
  allowlists exclude every flag that can omit a dependency the lockfile pins —
  `--lockfile-only`, `--prod`, `--production`, `--omit=dev`, `--filter=…`,
  `--workspace=…`, `--no-optional`, `--mode=update-lockfile` — because each one
  satisfies an install gate and leaves the pinned workspace CLI missing.
  `--ignore-scripts`, `--prefer-offline`, `--no-audit`, and their neighbours are
  allowed; an unknown flag is refused rather than guessed at;
- a first job whose install **command** does not itself pass that policy. The
  install must be a command the shell runs, at the same boundary a gate uses —
  a here-document body, a quoted block, and an `echo` argument install nothing,
  even on a line of their own — and the whole command is checked, not just its
  prefix, so `pnpm install --frozen-lockfile --prod` does not perform a declared
  `pnpm install --frozen-lockfile`;
- output that omits a declared gate;
- job and step shapes GitHub Actions rejects: duplicate or malformed job ids, a
  job with no steps, a step with both or neither of `uses` and `run`, `with:` on
  a `run` step, and a malformed `with:`/`env:` name;
- a `timeoutMinutes` outside 1..360, or one that is not a whole number. Zero and
  negative values are rejected by the runner and larger ones are silently
  capped, so both render a job that does not enforce what it declares. The attrs
  schema bounds it and `render` checks it again;
- a kind the CLI has no command for, such as `run`, which would render a step
  that fails with `COMMAND_NOT_FOUND`;
- a control character in a rendered value, such as the carriage return of a
  CRLF script, which the shell cannot run;
- a `pattern` outside the CLI's label grammar. The supported forms are exactly
  `//...`, `//pkg/...`, `//pkg`, `//pkg:target`, and `//:target`, with
  components of `[A-Za-z0-9_][A-Za-z0-9._-]*`. That rejects `*` and other globs,
  option-like values such as `--help` (which would make the pipeline's only real
  step a usage message exiting 0), `..` traversal, empty components, and more
  than one colon.

Rendered scalars are quoted unless YAML reads them back as exactly the declared
string. Every attribute is declared a `string`, so a value that would resolve to
a boolean (`true`, `yes`, `off`), null (`null`, `~`), a number (`22`, `1e5`,
`0x1A`, `0777`, `12:30`), or a timestamp (`2026-08-14`) is quoted — a workflow
named `true` would otherwise become the boolean `true`, and a branch `null` an
empty entry. The rule applies to KEYS too: a job id and a `with:`/`env:` name
are declared strings as much as values are, so `no:`, `ON:`, and `Y:` are
quoted rather than left to resolve to booleans. Unambiguous values and keys keep
their unquoted form byte for byte.

`runs-on` is the one attribute whose declared string may be a YAML sequence. A
label set (`[self-hosted, linux]`) stays a sequence, and each label is judged on
its own terms, so `[self-hosted, null]` renders `[self-hosted, "null"]` rather
than silently losing a label. A value that opens a flow collection without being
that label set — `[self-hosted, my label]`, `{group: g, labels: [x]}`, `[]` — is
**refused**, because quoting it would produce a single label no runner carries
and a job that never picks up. An expression (`${{ matrix.os }}`) is a quoted
scalar, which GitHub still evaluates.

The first rendered job receives the tsflows command, running the workspace
binary the declared install pinned — `pnpm exec`, `npm exec --no-install --`,
`yarn run`, or `bun run`. Nothing is fetched from a registry. A complete
build/test/lint set uses one `pnpm exec tsflows ci '<pattern>'`; other sets
receive one command per verb. The pattern is rendered as one single-quoted shell
word, which is a literal in every default GitHub Actions shell (`bash` on Linux
and macOS, `pwsh` on Windows), so the runner cannot glob-expand or re-split it.

In contract and check modes the output is a declared input and the target is
cacheable. Write mode is non-cacheable and declares the workflow as an output,
not an input.

## Channels and status

|          |                                                                              |
| -------- | ---------------------------------------------------------------------------- |
| Kinds    | `build`, `lint`                                                              |
| Success  | `Schema.Void`                                                                |
| Error    | `WriteFileError \| DriftError`                                               |
| Executes | Yes. The executor provides write, byte-check, and workflow-contract actions. |

## See also

- [PackageJson](package-json-gen.md)
- [Running targets](../../workspace/running-targets.md)
- [Remote caching](../../workspace/remote-caching.md)
