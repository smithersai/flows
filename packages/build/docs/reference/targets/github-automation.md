# GithubAutomation

Generates one `.github/workflows/gen.<slug>.yml` from a declarative trigger set
and a small typed job vocabulary, and enforces a structural safety property on
any job that reads untrusted text.

Where [GithubCiGen](github-ci-gen.md) verifies a hand-written pipeline,
this target owns its output. The two cover opposite cases: a repository's CI is
long-lived, commented, and hand-tuned; its event-driven automation is written
once, read rarely, and is exactly where a mistake is expensive.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
export const anthropicKey = Smithers.Secret("ANTHROPIC_API_KEY")

export const pocLoop = Smithers.GithubAutomation({
  slug: "poc-loop",
  target: "pocLoop",
  workflowName: "Repro PoC loop",
  packageManager,
  on: { issues: ["labeled"], workflowDispatchInputs: [{ name: "issue", description: "The issue number" }] },
  concurrency: "gen-poc-loop-${{ github.event.issue.number || inputs.issue }}",
  jobs: [
    Smithers.Automation.agent({
      id: "author",
      entry: "poc.ts",
      requireApproval: true,
      permissions: { contents: "write", issues: "read" },
      secrets: [anthropicKey],
      uploads: [{ name: "poc", path: "factory/repros" }]
    }),
    Smithers.Automation.agent({
      id: "execute",
      entry: "poc-run.ts",
      untrustedInput: true,
      needs: ["author"],
      downloads: [{ name: "poc", path: "factory/repros" }],
      uploads: [{ name: "poc-result", path: "factory/repros" }]
    })
  ]
})
```

## The untrusted-input boundary

This is the reason the target exists. A job whose inputs include text an
untrusted party wrote — an issue body, a comment, a fork pull request —
declares `untrustedInput: true`. The renderer then forces three things and
**refuses** any declaration that contradicts them:

1. **A gate condition.** The job renders
   `if: ${{ <gate> }}`, where the gate admits an actor whose author
   association is `OWNER`, `MEMBER`, or `COLLABORATOR`, an issue or pull
   request carrying the `agent:approved` label, or a `schedule` or
   `workflow_dispatch` run, which carries no untrusted actor to check. A
   declared `condition` is ANDed with the gate; it can narrow what runs, never
   widen it.
2. **No credential.** The job carries no declared secret, no `secrets.`
   expression, no `github.token`, and no `GITHUB_TOKEN` — in its declared
   secrets, its environment keys, its environment values, or its script. Each
   is a typed `UntrustedJobError` at plan time.
3. **Minimal read-only permissions.** The job renders `permissions: contents:
   read` regardless of what it declared, its checkout renders
   `persist-credentials: "false"` so a script it runs cannot find a token in
   `.git/config`, and it never installs the agent CLI: with no model
   credential there is nothing for one to run with. A declared write
   permission is refused rather than silently downgraded.

The refusal is what makes the property structural. A renderer that quietly
stripped the secret would emit a workflow that reads like the declaration and
behaves differently, and the next author would restore the secret because "it
was dropped". A refusal makes the author choose.

After rendering, the text is parsed back through the repository's own workflow
reader and the boundary is re-checked against what a reader sees, so a
rendering bug cannot ship a gate the declaration believed it had.

`requireApproval: true` applies the same gate to a **trusted** job without the
other restrictions. That is what an agent job holding a model credential
declares: it must not run for an arbitrary drive-by issue, but it does need its
key.

## The job vocabulary

Three shapes, and nothing else. A workflow that can only be one of three shapes
is a workflow whose safety property a renderer can enforce.

| Constructor                  | Runs                                           |
| ---------------------------- | ---------------------------------------------- |
| `Smithers.Automation.agent`  | One `factory/automation/<entry>` under `node`. |
| `Smithers.Automation.verb`   | One smthrs verb over a target pattern.         |
| `Smithers.Automation.script` | One shell script.                              |

Every job also renders, in order: a checkout, the declared manager's frozen
install, any `downloads`, the work step, and any `uploads`. `checkout` and
`install` can be turned off; a `verb` job may not turn off `install`, because
the binary it runs would not exist.

A `caches` entry renders an `actions/cache@v4` step, and is **refused** on an
untrusted-input job for the same reason a secret is: a cache an
attacker-influenced job can write is a channel into the next run.

Artifacts are the only channel between an untrusted-input sandbox and the
trusted job that acts on its result. The sandbox holds no credential, so it
cannot post anything; it writes a file, and a gated job with the token reads
it.

## Modes and verbs

| Verb    | Mode    | Behavior                                              |
| ------- | ------- | ----------------------------------------------------- |
| `build` | `check` | Byte-compares the checked-in file against the render. |
| `lint`  | `check` | The same. This is the drift gate `smthrs ci` runs.    |
| `run`   | `write` | Renders and writes.                                   |

`smthrs ci` can therefore never rewrite a workflow, and `smthrs run
//:<target>` is the only writer. A `run` target is excluded from generated
pipelines by construction, so no unattended pipeline can regenerate a workflow
it is running under. That is exactly what the marker header tells the reader:

```yaml
# GENERATED by //:pocLoop. Do not edit. Edit BUILD.ts and run smthrs run //:pocLoop.
```

In `check` mode the output file is a declared input, so a hand edit re-keys the
target and the gate runs again.

## Attributes

| Name             | Type                              | Default                       | Description                                                                                                                                       |
| ---------------- | --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`           | `string`                          | required                      | Lowercase, `[a-z][a-z0-9-]*`. The output is `.github/workflows/gen.<slug>.yml`; it is not separately declarable.                                  |
| `target`         | `string`                          | required                      | The BUILD.ts export name, which the marker header tells an editor to run.                                                                         |
| `workflowName`   | `string`                          | required                      | The operator-facing workflow name.                                                                                                                |
| `on`             | `Triggers`                        | required                      | `issues`, `issueComment`, `pullRequest`, `pullRequestTarget`, `schedule`, `workflowDispatch`, `workflowDispatchInputs`. At least one is required. |
| `jobs`           | `Array<Job>`                      | required                      | One or more jobs, in render order.                                                                                                                |
| `permissions`    | `Record<string, PermissionLevel>` | `{ contents: "read" }`        | Workflow-level `GITHUB_TOKEN` permissions. Scopes are checked against the known set.                                                              |
| `concurrency`    | `string`                          | optional                      | The `concurrency.group` expression. `cancel-in-progress` is always false: cancelling a bookkeeping job mid-commit is worse than queuing.          |
| `packageManager` | `PackageManager.PackageManager`   | required                      | The declared manager. Its frozen install is what every job runs.                                                                                  |
| `nodeVersion`    | `string`                          | `"22.19.0"`                   | The version the generated `setup-node` step pins.                                                                                                 |
| `agentCli`       | `string`                          | `"@anthropic-ai/claude-code"` | The npm package an `agent` job with `engine: true` installs globally before its entry runs.                                                       |
| `mode`           | `"check" \| "write"`              | `"check"`                     | Overridden per verb by `attrsForKind`.                                                                                                            |

### Job attributes

Shared by all three constructors:

| Name              | Type                              | Default           | Description                                                                 |
| ----------------- | --------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `id`              | `string`                          | required          | The GitHub Actions job id.                                                  |
| `name`            | `string`                          | optional          | The operator-facing job name.                                               |
| `runsOn`          | `string`                          | `"ubuntu-latest"` | A label, or a `[label, label]` set.                                         |
| `needs`           | `Array<string>`                   | `[]`              | Job ids in this workflow. A dangling or self reference is refused.          |
| `condition`       | `string`                          | optional          | An extra `if:` expression, ANDed with the gate on a gated job.              |
| `untrustedInput`  | `boolean`                         | `false`           | Applies the full boundary above.                                            |
| `requireApproval` | `boolean`                         | `false`           | Applies the gate condition alone. Implied by `untrustedInput`.              |
| `secrets`         | `Array<Secret.Secret>`            | `[]`              | Rendered as `NAME: ${{ secrets.NAME }}`. Refused on an untrusted-input job. |
| `env`             | `Record<string, string>`          | `{}`              | Literal environment entries.                                                |
| `permissions`     | `Record<string, PermissionLevel>` | `{}`              | Forced to `contents: read` on an untrusted-input job.                       |
| `timeoutMinutes`  | `number`                          | optional          | A whole number from 1 to 360.                                               |
| `checkout`        | `boolean`                         | `true`            | Whether the job checks the repository out.                                  |
| `fullHistory`     | `boolean`                         | `false`           | Renders `fetch-depth: "0"`, for a job that compares revisions.              |
| `install`         | `boolean`                         | `true`            | Whether the job installs the workspace.                                     |
| `downloads`       | `Array<Artifact>`                 | `[]`              | Downloaded before the work step.                                            |
| `uploads`         | `Array<Artifact>`                 | `[]`              | Uploaded after it, with `if-no-files-found: error`.                         |
| `caches`          | `Array<Cache>`                    | `[]`              | `actions/cache@v4` steps. Refused on an untrusted-input job.                |

`agent` adds `entry` (a lowercase `.ts` file directly under
`factory/automation`), `args` (plain words), and `engine` (default `true`):
whether the entry calls the model, so the job installs `agentCli` before the
entry runs. `verb` adds `verb` and `pattern`, validated against the CLI's
label grammar and rendered as one single-quoted shell word. `script` adds
`run`.

`pullRequestTarget` renders `pull_request_target`: the run has the base
repository's secrets even for a fork pull request, and its checkout is the
BASE branch, never the head, so a job on this event cannot execute pull
request code by construction. A job that must run it subscribes to
`pullRequest` instead. `workflowDispatchInputs` declares typed inputs on the
manual trigger; an entry reads one through a literal
`env: { ISSUE_NUMBER: "${{ inputs.issue }}" }` entry.

## Errors

| Error                        | Raised when                                                             |
| ---------------------------- | ----------------------------------------------------------------------- |
| `UntrustedJobError`          | A declaration would weaken the untrusted-input boundary.                |
| `AutomationDeclarationError` | A shape GitHub Actions rejects, or one the vocabulary does not express. |
| `WriteFileError`             | The generated file could not be written.                                |
| `DriftError`                 | The checked-in file is missing or differs from the render.              |

Both refusals happen at plan time, before an action is scheduled. Nothing is
written by a declaration the renderer could not prove safe.

## Rendering

YAML quoting goes through the same primitives `GithubCiGen` uses
(`GithubYaml`), so a scalar is quoted unless YAML reads it back as exactly the
declared string, keys included. There is one definition of that judgment
shared by both rules.

## Channels and status

|          |                                                              |
| -------- | ------------------------------------------------------------ |
| Kinds    | `build`, `lint`, `run`                                       |
| Success  | `Schema.Void`                                                |
| Error    | `WriteFileError \| DriftError`                               |
| Executes | Yes. The executor provides the write and byte-check actions. |

## See also

- [GithubCiGen](github-ci-gen.md)
- [GitHub automation](../../workspace/github-automation.md)
- [Running targets](../../workspace/running-targets.md)
