/**
 * Declarative GitHub Actions automation workflows, generated from BUILD.ts.
 *
 * `GithubCiGen` owns the repository's hand-written pipeline and defaults to
 * verifying it. This rule owns the opposite case: the small event-driven
 * workflows that drive the software factory's GitHub side. Those are written
 * once, read rarely, and are exactly where a mistake is expensive, so they are
 * generated from a declaration and byte-checked in CI rather than maintained by
 * hand.
 *
 * The declaration is a trigger set plus jobs drawn from a three-item
 * vocabulary: an `agent` job runs one `factory/automation/` entry, a `verb` job
 * runs one smthrs verb, and a `script` job runs a plain shell script. Nothing
 * else is expressible, which is the point: a workflow that can only be one of
 * three shapes is a workflow whose safety property can be enforced by the
 * renderer.
 *
 * ## The structural safety property
 *
 * A job whose inputs include text an untrusted party wrote — an issue body, a
 * comment, a fork pull request — declares `untrustedInput: true`. The renderer
 * then forces three things on that job and refuses to render any declaration
 * that contradicts them:
 *
 * 1. **A gate condition.** The job runs only when the actor's author
 *    association is `OWNER`, `MEMBER`, or `COLLABORATOR`, or when a maintainer
 *    has applied the {@link maintainerApprovalLabel} label to the issue or
 *    pull request. A declared `condition` is ANDed with the gate, never
 *    substituted for it.
 * 2. **No secrets.** The job carries no declared secret, and no `secrets.`
 *    expression anywhere in its environment or its script. Passing a secret to
 *    a job that executes attacker-supplied text is the exact defect this rule
 *    exists to make unexpressible, so it is a typed refusal
 *    ({@link UntrustedJobError}) at plan time, not a lint warning.
 * 3. **Minimal read-only permissions.** The job's `GITHUB_TOKEN` gets
 *    `contents: read` and nothing else, and its checkout does not persist
 *    credentials.
 *
 * The refusal fails closed. A declaration the renderer cannot prove safe does
 * not render a weaker workflow; it does not render at all.
 *
 * ## Modes
 *
 * `check` (the default) byte-compares the checked-in file against the render,
 * which is the drift gate the `ci` verb runs. `write` regenerates. The two are
 * bound to verbs by {@link GithubAutomation}'s `attrsForKind`: `build` and
 * `lint` check, `run` writes. So `smthrs ci` can never rewrite a workflow, and
 * `smthrs run //:<target>` is the one way to regenerate one. That is the
 * instruction every generated file carries in its marker header.
 *
 * @since 0.1.0
 */
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { DriftError, type FileRequirement, generateFile, resolveOutputPath, WriteFileError } from "./GeneratedFile.ts"
import * as GithubWorkflow from "./GithubWorkflow.ts"
import { hasControlCharacter, mapping, renderStep, runner, scalar } from "./GithubYaml.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * The directory every `agent` job entry resolves against.
 *
 * @category constants
 * @since 0.1.0
 */
export const automationDirectory = "factory/automation"

/**
 * The label a maintainer applies to admit an untrusted-input job.
 *
 * @category constants
 * @since 0.1.0
 */
export const maintainerApprovalLabel = "agent:approved"

/**
 * The author associations that admit an untrusted-input job without a label.
 *
 * @category constants
 * @since 0.1.0
 */
export const trustedAssociations: ReadonlyArray<string> = ["OWNER", "MEMBER", "COLLABORATOR"]

const associationCheck = (path: string): string =>
  `contains(fromJSON('${JSON.stringify(trustedAssociations)}'), ${path})`

/**
 * The `if:` expression the renderer forces on every untrusted-input job.
 *
 * It is one constant rather than a per-job derivation because it is the whole
 * security boundary: a derivation has cases, and a case is where a gate goes
 * missing. The associations cover the three event payloads a factory workflow
 * reads, and the label covers everyone else, applied by a maintainer.
 *
 * @category constants
 * @since 0.1.0
 */
export const untrustedInputGate: string = [
  associationCheck("github.event.issue.author_association"),
  associationCheck("github.event.comment.author_association"),
  associationCheck("github.event.pull_request.author_association"),
  `contains(github.event.issue.labels.*.name, '${maintainerApprovalLabel}')`,
  `contains(github.event.pull_request.labels.*.name, '${maintainerApprovalLabel}')`
].join(" || ")

/**
 * A declaration the renderer refuses because it would weaken the
 * untrusted-input boundary.
 *
 * @category errors
 * @since 0.1.0
 */
export class UntrustedJobError extends Schema.TaggedError<UntrustedJobError>()(
  "smithers-build/UntrustedJobError",
  {
    job: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * A declaration the renderer refuses for a reason unrelated to the
 * untrusted-input boundary: a shape GitHub Actions rejects, or one this rule's
 * vocabulary does not express.
 *
 * @category errors
 * @since 0.1.0
 */
export class AutomationDeclarationError extends Schema.TaggedError<AutomationDeclarationError>()(
  "smithers-build/AutomationDeclarationError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * Output handling. `check` byte-compares, `write` regenerates.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Mode = Schema.Literals(["check", "write"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("check" as const))
)

/**
 * Output handling.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = typeof Mode.Type

/**
 * The `issues` activity types a declaration may subscribe to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const IssueActivity = Schema.Literals([
  "opened",
  "edited",
  "reopened",
  "closed",
  "labeled",
  "unlabeled"
])

/**
 * The `issue_comment` activity types a declaration may subscribe to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const IssueCommentActivity = Schema.Literals(["created", "edited"])

/**
 * The `pull_request` activity types a declaration may subscribe to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PullRequestActivity = Schema.Literals([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "labeled",
  "unlabeled"
])

/**
 * A POSIX five-field cron expression.
 *
 * The charset is closed rather than fully validated. GitHub rejects a
 * malformed schedule at parse time, but it does so silently for the workflow's
 * whole lifetime, so anything outside the cron alphabet is refused here where
 * the declaration is written.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Cron = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[0-9*/,\- ]+$/)
)

/**
 * The trigger surface one automation workflow subscribes to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Triggers = Schema.Struct({
  /** `issues` activity types. Empty means the event is not subscribed. */
  issues: Schema.Array(IssueActivity).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<typeof IssueActivity.Type>>([]))
  ),
  /** `issue_comment` activity types. */
  issueComment: Schema.Array(IssueCommentActivity).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<typeof IssueCommentActivity.Type>>([]))
  ),
  /** `pull_request` activity types. */
  pullRequest: Schema.Array(PullRequestActivity).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<typeof PullRequestActivity.Type>>([]))
  ),
  /** `schedule` cron expressions. */
  schedule: Schema.Array(Cron).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /** Whether the workflow is manually dispatchable. @default false */
  workflowDispatch: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)))
})

/**
 * The trigger surface one automation workflow subscribes to.
 *
 * @category models
 * @since 0.1.0
 */
export type Triggers = typeof Triggers.Type

/**
 * A `GITHUB_TOKEN` permission scope a job may declare.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PermissionScope = Schema.Literals([
  "actions",
  "checks",
  "contents",
  "issues",
  "pull-requests",
  "statuses"
])

/**
 * A `GITHUB_TOKEN` permission level.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PermissionLevel = Schema.Literals(["none", "read", "write"])

/**
 * Every `GITHUB_TOKEN` scope a declaration may name.
 *
 * The mapping is keyed by plain strings rather than by
 * {@link PermissionScope} because a literal-keyed record is total: it would
 * require every scope on every job. The keys are checked against this set at
 * render time instead, so a typo is still a refusal and not a silently
 * ignored line.
 *
 * @category constants
 * @since 0.1.0
 */
export const permissionScopes: ReadonlyArray<string> = [
  "actions",
  "checks",
  "contents",
  "issues",
  "pull-requests",
  "statuses"
]

/**
 * A `permissions:` mapping.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Permissions = Schema.Record(Schema.String, PermissionLevel)

/**
 * A `permissions:` mapping.
 *
 * @category models
 * @since 0.1.0
 */
export type Permissions = typeof Permissions.Type

/**
 * One directory a job restores and saves across runs.
 *
 * A cache is the only state a generated automation workflow carries between
 * runs, so it is refused on an `untrustedInput` job: a cache a job can write
 * is a channel, and a channel between an attacker-influenced job and the next
 * run is exactly the thing this rule exists to prevent.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Cache = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  key: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  /** Prefixes a partial restore may match. @default [] */
  restoreKeys: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(512))).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  )
})

/**
 * One directory a job restores and saves across runs.
 *
 * @category models
 * @since 0.1.0
 */
export type Cache = typeof Cache.Type

/**
 * One workflow artifact a job publishes or consumes.
 *
 * Artifacts are the only channel between an untrusted-input sandbox job and
 * the trusted job that acts on its result. The sandbox holds no credential, so
 * it cannot post anything itself; it writes a file, and a gated job with the
 * token reads it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Artifact = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  path: Schema.NonEmptyString.check(Schema.isMaxLength(512))
})

/**
 * One workflow artifact a job publishes or consumes.
 *
 * @category models
 * @since 0.1.0
 */
export type Artifact = typeof Artifact.Type

const jobFields = {
  /** The GitHub Actions job id. */
  id: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  /** The operator-facing job name. */
  name: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(200))),
  /** @default "ubuntu-latest" */
  runsOn: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("ubuntu-latest"))),
  /** Job ids this job waits for. @default [] */
  needs: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * An extra `if:` expression. On an untrusted-input job it is ANDed with
   * {@link untrustedInputGate}; it can narrow the gate, never widen it.
   */
  condition: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
  /**
   * Whether this job's inputs include text an untrusted party wrote. @default
   * false
   */
  untrustedInput: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /**
   * Whether the job runs only behind {@link untrustedInputGate}, without the
   * rest of the untrusted-input restrictions. This is what a TRUSTED job that
   * reacts to an untrusted event declares: an agent job holding
   * `ANTHROPIC_API_KEY` still must not run for an arbitrary drive-by issue, but
   * it does need its credential. `untrustedInput: true` implies it. @default
   * false
   */
  requireApproval: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /** Declared secrets exported into the job's environment. @default [] */
  secrets: Schema.Array(Secret.Declaration).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Secret.Secret>>([]))
  ),
  /** Literal environment entries. @default {} */
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, string>>({}))
  ),
  /**
   * The job's `GITHUB_TOKEN` permissions. Forced to `contents: read` on an
   * untrusted-input job. @default {}
   */
  permissions: Permissions.pipe(
    Schema.withConstructorDefault(Effect.succeed<Permissions>({}))
  ),
  /** `timeout-minutes`, in the range GitHub Actions honours. */
  timeoutMinutes: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(360))
  ),
  /** Whether the job checks the repository out. @default true */
  checkout: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  /** Whether the job installs the workspace. @default true */
  install: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  /** Artifacts the job downloads before its work step. @default [] */
  downloads: Schema.Array(Artifact).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Artifact>>([]))
  ),
  /** Artifacts the job uploads after its work step. @default [] */
  uploads: Schema.Array(Artifact).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Artifact>>([]))
  ),
  /** Directories restored and saved across runs. Refused on an untrusted-input job. @default [] */
  caches: Schema.Array(Cache).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Cache>>([]))
  )
}

/**
 * A job that runs one `factory/automation/` entry.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AgentJob = Schema.TaggedStruct("agent", {
  ...jobFields,
  /** The entry file name under {@link automationDirectory}. */
  entry: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  /** Literal argv words appended to the entry. @default [] */
  args: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(128))).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  )
})

/**
 * A job that runs one smthrs verb over a target pattern.
 *
 * @category schemas
 * @since 0.1.0
 */
export const VerbJob = Schema.TaggedStruct("verb", {
  ...jobFields,
  /** The smthrs verb. `run` is excluded: run targets may be long-lived. */
  verb: Schema.Literals(["build", "test", "lint", "docs", "ci"]),
  /** The target pattern the verb runs over. */
  pattern: Schema.NonEmptyString.check(Schema.isMaxLength(256))
})

/**
 * A job that runs a plain shell script.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ScriptJob = Schema.TaggedStruct("script", {
  ...jobFields,
  /** The script. Rendered as a block scalar when it spans lines. */
  run: Schema.NonEmptyString.check(Schema.isMaxLength(64 * 1024))
})

/**
 * One declared job.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Job = Schema.Union([AgentJob, VerbJob, ScriptJob])

/**
 * One declared job.
 *
 * @category models
 * @since 0.1.0
 */
export type Job = typeof Job.Type

/**
 * Constructs an agent job: one `factory/automation/` entry.
 *
 * @category constructors
 * @since 0.1.0
 */
export const agent = (attrs: typeof AgentJob["~type.make.in"]): typeof AgentJob.Type => AgentJob.make(attrs)

/**
 * Constructs a smthrs verb job.
 *
 * @category constructors
 * @since 0.1.0
 */
export const verb = (attrs: typeof VerbJob["~type.make.in"]): typeof VerbJob.Type => VerbJob.make(attrs)

/**
 * Constructs a plain script job.
 *
 * @category constructors
 * @since 0.1.0
 */
export const script = (attrs: typeof ScriptJob["~type.make.in"]): typeof ScriptJob.Type => ScriptJob.make(attrs)

/** The workflow slug shape. It becomes a file name, so it stays lowercase. */
const slugShape = /^[a-z][a-z0-9-]*$/

/** GitHub's own job-id shape. */
const jobIdShape = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** The shape of an environment variable name. */
const environmentKeyShape = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The entry file shape an agent job may name. */
const entryShape = /^[a-z][a-z0-9-]*\.ts$/

/** An argv word safe to render unquoted into a generated script. */
const argumentShape = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

/** A target pattern the CLI's label grammar accepts, single-quoted when run. */
const patternShape =
  /^\/\/(?:\.\.\.|[A-Za-z0-9_][A-Za-z0-9._/-]*(?:\/\.\.\.)?(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?|:[A-Za-z0-9_][A-Za-z0-9._-]*)$/

/**
 * Attributes for {@link GithubAutomation}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /**
   * The workflow slug. The output path is
   * `.github/workflows/gen.<slug>.yml`, so it is not separately declarable:
   * a generated file whose path is free to disagree with its declaration is a
   * generated file the drift gate points at the wrong place.
   */
  slug: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  /**
   * The BUILD.ts export name this declaration is bound to. It is what the
   * marker header tells an editor to run, so it must be the name that actually
   * resolves: `smthrs run //:<target>`.
   */
  target: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  /** The operator-facing workflow name. */
  workflowName: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  /** The trigger surface. */
  on: Triggers,
  /** The declared jobs, in render order. */
  jobs: Schema.Array(Job),
  /** Workflow-level permissions. @default `{ contents: "read" }` */
  permissions: Permissions.pipe(
    Schema.withConstructorDefault(Effect.succeed<Permissions>({ contents: "read" }))
  ),
  /** The `concurrency.group` expression. Omitted when unset. */
  concurrency: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(512))),
  /** The declared package manager. Its frozen install is what every job runs. */
  packageManager: PackageManager.PackageManager,
  /** The Node version the generated `setup-node` step pins. @default "22.19.0" */
  nodeVersion: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("22.19.0"))),
  mode: Mode
})

/**
 * Attributes for {@link GithubAutomation}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * The workspace-relative path one declaration generates.
 *
 * @category rendering
 * @since 0.1.0
 */
export const outputPath = (slug: string): string => `.github/workflows/gen.${slug}.yml`

/**
 * The first line of every generated automation workflow.
 *
 * The header names the target that owns the file and the exact command that
 * regenerates it. A generated file whose header only says "do not edit" sends
 * the reader looking for the generator; this one hands it over.
 *
 * @category rendering
 * @since 0.1.0
 */
export const markerHeader = (target: string): string =>
  `# GENERATED by //:${target}. Do not edit. Edit BUILD.ts and run smthrs run //:${target}.`

/**
 * Whether a rendered fragment reaches a credential.
 *
 * `secrets.` is the obvious half. `github.token` and `GITHUB_TOKEN` are the
 * half that would otherwise slip through: the workflow token is a credential
 * too, and an untrusted-input job that exported it would hand repository write
 * access to whatever script it was about to run.
 */
const reachesSecret = (value: string): boolean =>
  /secrets\s*\./.test(value) || /github\s*\.\s*token/.test(value) || value.includes("GITHUB_TOKEN")

const refuse = (message: string): never => {
  throw new AutomationDeclarationError({ message })
}

const refuseJob = (job: string, message: string): never => {
  throw new UntrustedJobError({ job, message })
}

/**
 * Applies the untrusted-input boundary to one job.
 *
 * Everything about it is a refusal rather than a repair. A renderer that
 * quietly strips a secret from an untrusted job produces a workflow that looks
 * like the declaration and behaves differently, and the next author restores
 * the secret because "it was dropped". A refusal makes the author decide.
 *
 * @category validation
 * @since 0.1.0
 */
export const checkUntrustedJob = (job: Job): void => {
  if (!job.untrustedInput) return
  if (job.secrets.length > 0) {
    refuseJob(
      job.id,
      `declares untrustedInput and the secret ${
        job.secrets.map((secret) => secret.env).join(", ")
      }; a job that executes untrusted text may not hold a credential`
    )
  }
  for (const [key, value] of Object.entries(job.env)) {
    if (reachesSecret(value) || reachesSecret(key)) {
      refuseJob(job.id, `declares untrustedInput and reaches a credential through env.${key}`)
    }
  }
  if (job._tag === "script" && reachesSecret(job.run)) {
    refuseJob(job.id, "declares untrustedInput and reaches a credential in its script")
  }
  if (job.caches.length > 0) {
    refuseJob(
      job.id,
      "declares untrustedInput and a cache; a cache an attacker-influenced job writes is a channel into the next run"
    )
  }
  const elevated = Object.entries(job.permissions).filter(([, level]) => level === "write")
  if (elevated.length > 0) {
    refuseJob(
      job.id,
      `declares untrustedInput and write permission on ${
        elevated.map(([scope]) => scope).join(", ")
      }; an untrusted-input job is read-only`
    )
  }
}

/** The permissions an untrusted-input job renders, whatever it declared. */
const untrustedPermissions: Permissions = { contents: "read" }

/**
 * The `if:` expression a job renders.
 *
 * A gated job's declared condition is ANDed with the forced gate. It can
 * narrow what runs, never widen it, which is why the gate is applied here
 * rather than left to the declaration.
 *
 * @category rendering
 * @since 0.1.0
 */
export const jobCondition = (job: Job): string | undefined => {
  if (!job.untrustedInput && !job.requireApproval) {
    return job.condition === undefined ? undefined : `\${{ ${job.condition} }}`
  }
  return job.condition === undefined
    ? `\${{ ${untrustedInputGate} }}`
    : `\${{ (${untrustedInputGate}) && (${job.condition}) }}`
}

const checkPermissionScopes = (permissions: Permissions, owner: string): void => {
  for (const scope of Object.keys(permissions)) {
    if (!permissionScopes.includes(scope)) {
      refuse(
        `${owner} declares the permission scope ${JSON.stringify(scope)}, which is not one of ${
          permissionScopes.join(", ")
        }`
      )
    }
  }
}

const validateCommon = (attrs: Attrs): void => {
  if (!slugShape.test(attrs.slug)) {
    refuse(`${JSON.stringify(attrs.slug)} is not a workflow slug; use lowercase letters, digits, and "-"`)
  }
  if (!slugShape.test(attrs.target) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(attrs.target)) {
    refuse(`${JSON.stringify(attrs.target)} is not a BUILD.ts export name`)
  }
  const triggers = attrs.on
  if (
    triggers.issues.length === 0 && triggers.issueComment.length === 0 &&
    triggers.pullRequest.length === 0 && triggers.schedule.length === 0 &&
    !triggers.workflowDispatch
  ) {
    refuse(`workflow ${JSON.stringify(attrs.slug)} declares no trigger, so nothing would ever run it`)
  }
  if (attrs.jobs.length === 0) {
    refuse(`workflow ${JSON.stringify(attrs.slug)} declares no jobs`)
  }
  checkPermissionScopes(attrs.permissions, `workflow ${JSON.stringify(attrs.slug)}`)
  const ids = new Set<string>()
  for (const job of attrs.jobs) {
    if (!jobIdShape.test(job.id)) {
      refuse(`${JSON.stringify(job.id)} is not a valid job id; use letters, digits, "-", and "_"`)
    }
    if (ids.has(job.id)) refuse(`duplicate job id ${JSON.stringify(job.id)}`)
    ids.add(job.id)
  }
  for (const job of attrs.jobs) {
    for (const need of job.needs) {
      if (!ids.has(need)) {
        refuse(`job ${JSON.stringify(job.id)} needs ${JSON.stringify(need)}, which this workflow does not declare`)
      }
      if (need === job.id) refuse(`job ${JSON.stringify(job.id)} needs itself`)
    }
    checkPermissionScopes(job.permissions, `job ${JSON.stringify(job.id)}`)
    for (const key of Object.keys(job.env)) {
      if (!environmentKeyShape.test(key)) {
        refuse(`${JSON.stringify(key)} in job ${JSON.stringify(job.id)} is not an environment variable name`)
      }
    }
    if (job._tag === "agent" && !entryShape.test(job.entry)) {
      refuse(
        `job ${JSON.stringify(job.id)} names the entry ${
          JSON.stringify(job.entry)
        }; an entry is a lowercase ".ts" file directly under ${automationDirectory}`
      )
    }
    if (job._tag === "agent") {
      for (const argument of job.args) {
        if (!argumentShape.test(argument)) {
          refuse(
            `job ${JSON.stringify(job.id)} passes the argument ${JSON.stringify(argument)}, which is not a plain word`
          )
        }
      }
    }
    if (job._tag === "verb" && !patternShape.test(job.pattern)) {
      refuse(
        `job ${JSON.stringify(job.id)} runs over ${
          JSON.stringify(job.pattern)
        }, which is not a target pattern; use //..., //pkg/..., //pkg, or //pkg:target`
      )
    }
    if (job._tag === "script" && hasControlCharacter(job.run)) {
      refuse(`job ${JSON.stringify(job.id)} has a control character in its script`)
    }
    if (!job.install && job._tag === "verb") {
      refuse(`job ${JSON.stringify(job.id)} runs a smthrs verb with install disabled; the binary would not exist`)
    }
    if (!job.checkout && (job.install || job._tag !== "script")) {
      refuse(`job ${JSON.stringify(job.id)} skips checkout but still needs the working tree`)
    }
  }
}

/** The workflow's `on:` block. */
const renderTriggers = (triggers: Triggers): ReadonlyArray<string> => {
  const lines: Array<string> = ["on:"]
  if (triggers.issues.length > 0) {
    lines.push("  issues:", `    types: [${triggers.issues.map(scalar).join(", ")}]`)
  }
  if (triggers.issueComment.length > 0) {
    lines.push("  issue_comment:", `    types: [${triggers.issueComment.map(scalar).join(", ")}]`)
  }
  if (triggers.pullRequest.length > 0) {
    lines.push("  pull_request:", `    types: [${triggers.pullRequest.map(scalar).join(", ")}]`)
  }
  if (triggers.schedule.length > 0) {
    lines.push("  schedule:")
    for (const cron of triggers.schedule) lines.push(`    - cron: ${scalar(cron)}`)
  }
  if (triggers.workflowDispatch) lines.push("  workflow_dispatch:")
  return lines
}

const renderPermissions = (permissions: Permissions, indent: string): ReadonlyArray<string> =>
  Object.keys(permissions).length === 0
    ? []
    : [`${indent}permissions:`, ...mapping(permissions, `${indent}  `)]

/** The environment one job's work step carries. */
const stepEnvironment = (job: Job): Record<string, string> => {
  const env: Record<string, string> = { ...job.env }
  for (const secret of job.secrets) env[secret.env] = `\${{ secrets.${secret.env} }}`
  return env
}

/** The command one job's work step runs. */
const workCommand = (job: Job, exec: string): string => {
  if (job._tag === "script") return job.run
  if (job._tag === "verb") return `${exec} smthrs ${job.verb} '${job.pattern}'`
  return ["node", `${automationDirectory}/${job.entry}`, ...job.args].join(" ")
}

const setupSteps = (job: Job, attrs: Attrs, install: string): ReadonlyArray<string> => {
  const lines: Array<string> = []
  if (job.checkout) {
    lines.push(...renderStep(
      job.untrustedInput
        // An untrusted-input job must not carry a token the checkout leaves on
        // disk: a PoC script it runs would find it in .git/config.
        ? { uses: "actions/checkout@v4", with: { "persist-credentials": "false" } }
        : { uses: "actions/checkout@v4" },
      "      "
    ))
  }
  if (job.install) {
    lines.push(
      ...renderStep({ uses: "pnpm/action-setup@v6" }, "      "),
      ...renderStep(
        { uses: "actions/setup-node@v4", with: { "node-version": attrs.nodeVersion, cache: "pnpm" } },
        "      "
      ),
      ...renderStep({ run: install }, "      ")
    )
  }
  for (const cache of job.caches) {
    lines.push(...renderStep({
      name: `Cache ${cache.path}`,
      uses: "actions/cache@v4",
      with: {
        path: cache.path,
        key: cache.key,
        ...(cache.restoreKeys.length === 0 ? {} : { "restore-keys": cache.restoreKeys.join("\n") })
      }
    }, "      "))
  }
  for (const artifact of job.downloads) {
    lines.push(...renderStep({
      name: `Download ${artifact.name}`,
      uses: "actions/download-artifact@v4",
      with: { name: artifact.name, path: artifact.path }
    }, "      "))
  }
  return lines
}

/**
 * Renders one automation workflow, deterministically.
 *
 * It fails closed. Anything the vocabulary cannot express, and anything that
 * would weaken the untrusted-input boundary, throws
 * {@link AutomationDeclarationError} or {@link UntrustedJobError} at plan time
 * rather than emitting a workflow that behaves differently from its
 * declaration. The rendered text is then parsed back through
 * {@link GithubWorkflow.parseWorkflow} and the boundary is re-checked against
 * what a reader actually sees, so a rendering bug cannot ship a gate the
 * declaration believed it had.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (attrs: Attrs): string => {
  validateCommon(attrs)
  for (const job of attrs.jobs) checkUntrustedJob(job)
  const install = PackageManager.install(attrs.packageManager, { frozen: true, ignoreScripts: true }).join(" ")
  const exec = GithubWorkflow.workspaceExec(install)
  if (exec === undefined) {
    refuse(`${JSON.stringify(install)} is not a supported lockfile install`)
  }
  const lines: Array<string> = [
    markerHeader(attrs.target),
    `name: ${scalar(attrs.workflowName)}`,
    ...renderTriggers(attrs.on),
    ...renderPermissions(attrs.permissions, "")
  ]
  if (attrs.concurrency !== undefined) {
    lines.push("concurrency:", `  group: ${scalar(attrs.concurrency)}`, "  cancel-in-progress: false")
  }
  lines.push("jobs:")
  for (const job of attrs.jobs) {
    lines.push(`  ${scalar(job.id)}:`)
    if (job.name !== undefined) lines.push(`    name: ${scalar(job.name)}`)
    lines.push(`    runs-on: ${runner(job.runsOn)}`)
    if (job.needs.length > 0) lines.push(`    needs: [${job.needs.map(scalar).join(", ")}]`)
    const condition = jobCondition(job)
    if (condition !== undefined) lines.push(`    if: ${condition}`)
    if (job.timeoutMinutes !== undefined) lines.push(`    timeout-minutes: ${job.timeoutMinutes}`)
    lines.push(...renderPermissions(job.untrustedInput ? untrustedPermissions : job.permissions, "    "))
    lines.push("    steps:")
    lines.push(...setupSteps(job, attrs, install))
    const env = stepEnvironment(job)
    lines.push(...renderStep({
      name: job.name === undefined ? undefined : `Run ${job.id}`,
      run: workCommand(job, exec!),
      ...(Object.keys(env).length === 0 ? {} : { env })
    }, "      "))
    for (const artifact of job.uploads) {
      lines.push(...renderStep({
        name: `Upload ${artifact.name}`,
        uses: "actions/upload-artifact@v4",
        with: { name: artifact.name, path: artifact.path, "if-no-files-found": "error" }
      }, "      "))
    }
  }
  const rendered = `${lines.join("\n")}\n`
  verifyRendered(attrs, rendered)
  return rendered
}

/**
 * Re-reads the rendered workflow and re-checks the untrusted-input boundary
 * against what a workflow reader sees, not against what the renderer intended.
 *
 * @category validation
 * @since 0.1.0
 */
export const verifyRendered = (attrs: Attrs, rendered: string): void => {
  if (!rendered.startsWith(markerHeader(attrs.target))) {
    refuse("the rendered workflow lost its generated-file marker header")
  }
  const workflow = GithubWorkflow.parseWorkflow(rendered)
  const declared = new Map(attrs.jobs.map((job) => [job.id, job]))
  for (const parsed of workflow.jobs) {
    const job = declared.get(parsed.id)
    if (job === undefined || (!job.untrustedInput && !job.requireApproval)) continue
    if (parsed.condition === undefined || !parsed.condition.includes(untrustedInputGate)) {
      refuseJob(job.id, "rendered without the untrusted-input gate condition")
    }
    if (!job.untrustedInput) continue
    for (const step of parsed.steps) {
      if (step.run !== undefined && reachesSecret(step.run)) {
        refuseJob(job.id, "rendered a step whose script reaches a credential")
      }
    }
  }
  const jobIds = new Set(workflow.jobs.map((parsed) => parsed.id))
  const missing = attrs.jobs.filter((job) => !jobIds.has(job.id)).map((job) => job.id)
  if (missing.length > 0) {
    refuse(`the rendered workflow does not carry the declared jobs: ${missing.join(", ")}`)
  }
}

/**
 * Generates one `.github/workflows/gen.<slug>.yml` from a declarative trigger
 * and job specification.
 *
 * The verb mapping is the safety-relevant part. `build` and `lint` both see
 * `check` mode, so `smthrs ci` reports drift and never repairs it; only
 * `smthrs run //:<target>` writes. A `run` target is excluded from generated
 * pipelines by construction, so no unattended pipeline can regenerate a
 * workflow it is running under.
 *
 * The `check` form declares the output file as an input, so a hand edit to a
 * generated workflow re-keys the target and the drift gate runs again.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
 * export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
 *
 * export const issueIntake = Smithers.GithubAutomation({
 *   slug: "issue-intake",
 *   target: "issueIntake",
 *   workflowName: "Issue intake",
 *   packageManager,
 *   on: { issues: ["opened", "edited"] },
 *   jobs: [
 *     Smithers.Automation.agent({
 *       id: "intake",
 *       entry: "intake.ts",
 *       permissions: { contents: "read", issues: "write" },
 *       secrets: [Smithers.Secret("ANTHROPIC_API_KEY")]
 *     })
 *   ]
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const GithubAutomation = Target.make("GithubAutomation", {
  attrs: Attrs,
  kinds: ["build", "lint", "run"],
  error: Schema.Union([WriteFileError, DriftError]),
  cache: (attrs) => attrs.mode !== "write",
  inputs: (attrs) => attrs.mode === "write" ? [] : [Input.file(`//${outputPath(attrs.slug)}`)],
  attrsForKind: (kind, attrs) => ({ ...attrs, mode: kind === "run" ? "write" as const : "check" as const }),
  implementation: (
    attrs
  ): Node.Node<void, WriteFileError | DriftError, FileRequirement> =>
    generateFile(attrs.mode, {
      path: resolveOutputPath(outputPath(attrs.slug)),
      contents: render(attrs)
    })
})
