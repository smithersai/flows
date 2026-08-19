# GithubCiGen

Generates the GitHub Actions CI workflow from declared jobs. The workflow is a
generated root file on the same terms as `pnpm-workspace.yaml` and
`tsconfig.json`: BUILD.ts is the only description of the pipeline, `write`
renders it, and `check` — the default — fails on drift.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const ci = Smithers.GithubCiGen({
  packageManager,
  workflowName: "CI",
  pattern: "//...",
  pipelineVerbs: [Smithers.Verb.Build, Smithers.Verb.Test, Smithers.Verb.Lint],
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  cancelInProgress: true,
  install: "pnpm install --frozen-lockfile",
  jobs: [
    {
      id: "test",
      runsOn: "ubuntu-latest",
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "pnpm/action-setup@v6" },
        { run: "pnpm install --frozen-lockfile" },
        { name: "Typecheck", run: "pnpm run check" }
      ]
    }
  ],
  requiredJobs: ["test"],
  gates: [
    { name: "typecheck", command: "pnpm run check", job: "test" }
  ],
  output: ".github/workflows/ci.yml",
  mode: "check"
})
```

## Modes

| Mode    | Behavior                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| `check` | Default. Renders declared jobs and byte-compares the result with the checked-in workflow. It never writes. |
| `write` | Explicit generation. Validates and writes the rendered workflow.                                           |

The `lint` form maps `write` to `check`. `smthrs ci` plans lint first, so CI is
also non-mutating even if a target explicitly declares write mode. Only an
explicit `smthrs build` of a `mode: "write"` target generates a file.

## Attributes

| Name               | Type                            | Default                               | Description                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowName`     | `string`                        | `"CI"`                                | Generated workflow name.                                                                                                                                                                                                                                                                                          |
| `pattern`          | `string`                        | `"//..."`                             | Pattern executed by the generated smithers build step. Must be `//...`, `//pkg/...`, `//pkg`, `//pkg:target`, or `//:target`; rendered as one single-quoted shell word.                                                                                                                                           |
| `pipelineVerbs`    | `Array<Verb.Verb>`              | `Verb.all`                            | Typed verb values the generated step runs across `pattern`: `Verb.Build`, `Verb.Test`, `Verb.Lint`, and `Verb.Docs`. The complete set emits one `smthrs ci` command; other sets emit one command per verb. `Verb` defines no `run` value at all, because run targets may be long-lived or mutate the source tree. |
| `pushBranches`     | `Array<string>`                 | `["main"]`                            | Generated push branches.                                                                                                                                                                                                                                                                                          |
| `pullRequest`      | `boolean`                       | `true`                                | Generated pull-request trigger.                                                                                                                                                                                                                                                                                   |
| `workflowDispatch` | `boolean`                       | `true`                                | Generated manual trigger.                                                                                                                                                                                                                                                                                         |
| `cancelInProgress` | `boolean`                       | `true`                                | Generated concurrency policy.                                                                                                                                                                                                                                                                                     |
| `install`          | `string`                        | The declared manager's frozen install | Lockfile-respecting install command. Unsupported commands, and flags that can omit a pinned dependency, are rejected; the job that runs smithers build must run an install line that passes the same policy. It also selects the workspace-binary runner of the generated step.                                   |
| `packageManager`   | `PackageManager.PackageManager` | required                              | The declared package manager. The generated pipeline installs with it and runs the smthrs binary through it, so a workspace that switches managers gets a regenerated workflow.                                                                                                                                   |
| `cacheUrlSecret`   | `Secret.Secret`                 | optional                              | The declared secret supplying the remote-cache endpoint override. The generated step reads the repository secret of the same name.                                                                                                                                                                                |
| `cacheTokenSecret` | `Secret.Secret`                 | optional                              | The declared secret supplying the remote-cache bearer token. The generated step reads the repository secret of the same name.                                                                                                                                                                                     |
| `jobs`             | `Array<Job>`                    | `[]`                                  | Jobs rendered by `write` and `check`; the render refuses an empty list. A job's optional `timeoutMinutes` must be a whole number from 1 to 360.                                                                                                                                                                   |
| `gates`            | `Array<Gate>`                   | `[]`                                  | Named commands an unconditional step must still run, or actions it must still use, optionally in one job.                                                                                                                                                                                                         |
| `requiredJobs`     | `Array<string>`                 | `[]`                                  | Job ids the workflow must define **and run unconditionally**, in every mode.                                                                                                                                                                                                                                      |
| `output`           | `string`                        | `".github/workflows/ci.yml"`          | Workspace-relative workflow path.                                                                                                                                                                                                                                                                                 |
| `mode`             | `"check" \| "write"`            | `"check"`                             | Output handling described above.                                                                                                                                                                                                                                                                                  |

## Generation guarantees

What keeps the generator from silently deleting a repository's gates is the
render itself: before writing or comparing anything, the rendered workflow is
re-parsed and checked against every declared gate. The parser reads job ids,
every `run` and `uses` command, and
the `if:` and `continue-on-error:` of every job and step,
including sequences written at their key's own indentation (`steps:` and
`needs:` in the common compact style), and rejects a duplicate mapping key at every level it reads — a repeated
top-level key, job id, job field, or step field. YAML shadows all of them and
keeps the last, so a gate could otherwise match a job, a `steps:` block, or a
`run:` script GitHub never executes. A key is read unquoted, so `"test":` and
`test:` are the same job id, both to a gate and to the duplicate check. A
dropped gate or required job is a throw at plan time, before any file is
written; drift between the checked-in workflow and the render is a typed
`DriftError` carrying the workflow path.

Quoted scalar values are decoded before shell scanning. JSON-compatible
double-quoted escapes and YAML's doubled-single-quote form are supported;
other YAML-only escape forms are refused. The scanner therefore never treats
the source spelling of an escape as a different shell program and invents a
gate outside a quote that GitHub actually places inside it.

### What a required job proves

A `requiredJobs` entry asserts that the render defines the job: removing a job
without removing its entry is a throw at plan time rather than a pipeline that
quietly stopped running a lane. The renderer has no way to emit a job or step
`if:` at all, so every rendered job runs unconditionally. For reading a
workflow file directly, `GithubWorkflow.missingRequiredJobs` applies the
stricter run-unconditionally test and reports a conditional job as
`id (conditional)` rather than as missing.

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

- an empty job list, an empty `pipelineVerbs` list, and any declared
  `requiredJobs` id the render does not define;
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
- nothing needs refusing for the manual `run` kind: `Verb` defines no `run`
  value, so a pipeline that runs `run` targets is a declaration that cannot be
  written. Run targets may start long-lived development services or mutate the
  source tree (for example, a scaffold), which is why only `Verb.Build`,
  `Verb.Test`, `Verb.Lint`, and `Verb.Docs` exist;
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
empty entry. The target applies to KEYS too: a job id and a `with:`/`env:` name
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

The first rendered job receives the smthrs command, running the workspace
binary the declared install pinned — `pnpm exec`, `npm exec --no-install --`,
`yarn run`, or `bun run`. Nothing is fetched from a registry. Declaring every
verb (`Verb.all`) uses one `pnpm exec smthrs ci '<pattern>'`; other sets
receive one command per verb. The pattern is rendered as one single-quoted shell
word, which is a literal in every default GitHub Actions shell (`bash` on Linux
and macOS, `pwsh` on Windows), so the runner cannot glob-expand or re-split it.

In check mode the output is a declared input and the target is cacheable.
Write mode is non-cacheable and declares the workflow as an output, not an
input.

## Channels and status

|          |                                                          |
| -------- | -------------------------------------------------------- |
| Kinds    | `build`, `lint`                                          |
| Success  | `Schema.Void`                                            |
| Error    | `WriteFileError \| DriftError`                           |
| Executes | Yes. The executor provides write and byte-check actions. |

## See also

- [PackageJson](package-json-gen.md)
- [Running targets](../../workspace/running-targets.md)
- [Remote caching](../../workspace/remote-caching.md)
