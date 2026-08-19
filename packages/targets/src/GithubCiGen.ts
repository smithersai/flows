/**
 * Generated and verified GitHub Actions CI workflow.
 *
 * @since 0.1.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import {
  DriftError,
  driftError,
  failureMessage,
  generateFile,
  resolveOutputPath,
  WriteFileError
} from "./GeneratedFile.ts"
import * as GithubWorkflow from "./GithubWorkflow.ts"
import { controlCharacter, renderStep, runner, scalar } from "./GithubYaml.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as RemoteCache from "./RemoteCache.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * How a CI workflow target treats its output file.
 *
 * - `contract` — read the checked-in workflow and fail unless it still runs
 *   every declared gate. Non-mutating, and the DEFAULT, because a repository's
 *   pipeline is usually hand-written: it carries comments, `continue-on-error`
 *   advisories, matrix jobs, and platform lanes that no generator declaration
 *   reproduces, and replacing it with generated output is a downgrade even
 *   when the generator is correct.
 * - `check` — byte-compare the checked-in file against the rendered form.
 * - `write` — render the declared jobs and write the file.
 *
 * Only `write` touches the working tree, and only a target that declares it
 * gets it. `lint` maps `write` to `check` so no lint or CI run mutates a
 * workflow file.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OutputMode = Schema.Literals(["contract", "check", "write"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("contract" as const))
)

/**
 * How a CI workflow target treats its output file.
 *
 * @category models
 * @since 0.1.0
 */
export type OutputMode = typeof OutputMode.Type

/**
 * One command the pipeline must still run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Gate = Schema.Struct({
  /** Operator-facing name, used in the failure message. */
  name: Schema.NonEmptyString,
  /**
   * The command some unconditional step must still run, matched at a shell
   * command boundary of a `run` script, or the action some step must still
   * use, matched against a whole `uses` value. Never a substring.
   */
  command: Schema.NonEmptyString,
  /** When present, the job id the command must appear in. */
  job: Schema.optional(Schema.NonEmptyString)
})

/**
 * One command the pipeline must still run.
 *
 * @category models
 * @since 0.1.0
 */
export type Gate = typeof Gate.Type

/**
 * One rendered step.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Step = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  uses: Schema.optional(Schema.NonEmptyString),
  run: Schema.optional(Schema.NonEmptyString),
  with: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

/**
 * One rendered step.
 *
 * @category models
 * @since 0.1.0
 */
export type Step = typeof Step.Type

/**
 * The smallest `timeout-minutes` GitHub Actions runs. Zero and negative values
 * are a workflow the runner rejects.
 *
 * @category constants
 * @since 0.1.0
 */
export const minimumTimeoutMinutes = 1

/**
 * The largest `timeout-minutes` GitHub Actions honours. A larger value is
 * silently capped, so the rendered job would not enforce the timeout it
 * declares.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTimeoutMinutes = 360

/**
 * One rendered job.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.NonEmptyString),
  runsOn: Schema.NonEmptyString,
  /**
   * `timeout-minutes`, in the range GitHub Actions supports. Zero and negative
   * values are rejected by the runner, and anything above 360 is silently
   * clamped, so both render a job that does not do what it declares.
   */
  timeoutMinutes: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(minimumTimeoutMinutes),
      Schema.isLessThanOrEqualTo(maximumTimeoutMinutes)
    )
  ),
  continueOnError: Schema.optional(Schema.Boolean),
  steps: Schema.Array(Step)
})

/**
 * One rendered job.
 *
 * @category models
 * @since 0.1.0
 */
export type Job = typeof Job.Type

/**
 * Payload for one workflow contract check.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkflowContractPayload = Schema.Struct({
  path: Schema.NonEmptyString,
  gates: Schema.Array(Gate),
  requiredJobs: Schema.Array(Schema.NonEmptyString)
})

/**
 * Payload for one workflow contract check.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkflowContractPayload = typeof WorkflowContractPayload.Type

/**
 * The declared required jobs a workflow does not unconditionally run.
 *
 * A required job is required to RUN, on the same terms as a {@link Gate}: a job
 * carrying an `if:` is one GitHub may skip, so `if: false` on a required job is
 * a job the pipeline does not have. A job that exists but is conditional is
 * reported as `id (conditional)`, because "missing" would send an operator
 * looking for a job that is right there in the file.
 *
 * @category verification
 * @since 0.1.0
 */
export const missingRequiredJobs = (
  workflow: GithubWorkflow.Workflow,
  requiredJobs: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const declared = new Set(workflow.jobs.map((job) => job.id))
  const unconditional = new Set(
    workflow.jobs.filter((job) => GithubWorkflow.alwaysRuns(job.condition)).map((job) => job.id)
  )
  return requiredJobs
    .filter((id) => !unconditional.has(id))
    .map((id) => declared.has(id) ? `${id} (conditional)` : id)
}

/**
 * Reads a checked-in workflow and reports the declared gates it dropped.
 *
 * @category actions
 * @since 0.1.0
 */
export const CheckWorkflow = Action.make("smithers-build/check-workflow", {
  payload: WorkflowContractPayload,
  error: DriftError,
  tier: "sealed"
})

/**
 * Maximum encoded size of a workflow admitted to the structural scanner.
 *
 * @category constants
 * @since 0.1.0
 */
export const workflowSourceByteLimit = GithubWorkflow.maximumWorkflowBytes

/**
 * Reads one checked-in workflow through a bounded regular-file descriptor.
 *
 * The final path must be a regular file, not a symlink, FIFO, device, or
 * socket. `O_NONBLOCK` prevents a special-file swap from hanging at open;
 * `O_NOFOLLOW` and the lstat/fstat identity check reject a final-component
 * symlink race. Reading stops at one byte beyond the limit, so growth after
 * fstat cannot turn the check into an unbounded allocation. Invalid UTF-8 is
 * refused rather than normalized into replacement characters before parsing.
 *
 * @category filesystem
 * @since 0.1.0
 */
export const readWorkflowSource = async (
  workspaceRoot: string,
  path: string,
  signal?: AbortSignal | undefined
): Promise<string> => {
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  const relative = resolveOutputPath(path)
  const result = await SafeFs.readText(NodePath.join(root, relative), {
    root,
    signal,
    symlinks: "reject",
    limit: workflowSourceByteLimit,
    what: "workflow source"
  })
  if (result === undefined) throw new Error(`the workflow does not exist: ${path}`)
  return result
}

/**
 * Implements {@link CheckWorkflow} with a read and a structural workflow scan.
 * It never writes: a drift is reported, never repaired.
 *
 * @category layers
 * @since 0.1.0
 */
export const CheckWorkflowLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<Action.Requirement<"smithers-build/check-workflow">, never, FlowRuntime.FlowRuntime> =>
  CheckWorkflow.toLayer((payload) =>
    Effect.tryPromise({
      try: (signal) => readWorkflowSource(options.workspaceRoot, payload.path, signal),
      catch: (cause) => driftError(payload.path, failureMessage(cause))
    }).pipe(
      Effect.flatMap((source) =>
        Effect.try({
          try: () => GithubWorkflow.parseWorkflow(source),
          catch: (cause) =>
            driftError(
              payload.path,
              `the workflow could not be parsed: ${failureMessage(cause)}`
            )
        })
      ),
      Effect.flatMap((workflow) => {
        const missingJobs = missingRequiredJobs(workflow, payload.requiredJobs)
        const missing = GithubWorkflow.missingGates(workflow, payload.gates)
        if (missingJobs.length === 0 && missing.length === 0) return Effect.void
        return Effect.fail(
          driftError(
            payload.path,
            [
              missingJobs.length === 0 ? undefined : `missing jobs: ${missingJobs.join(", ")}`,
              missing.length === 0
                ? undefined
                : `missing gates: ${missing.map((gate) => `${gate.name} (${gate.command})`).join(", ")}`
            ].filter((part) => part !== undefined).join("; ")
          )
        )
      })
    )
  )

/**
 * Attributes for {@link GithubCiGen}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** @default "CI" */
  workflowName: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("CI"))
  ),
  pattern: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("//..."))),
  /**
   * The pipeline-safe verbs the generated smithers build step runs. Restricted to
   * {@link pipelineKinds}; `run` targets are deliberately manual because they
   * may be long-lived or mutate the source tree.
   */
  kinds: Schema.Array(Target.Kind).pipe(
    Schema.withConstructorDefault(
      Effect.succeed<ReadonlyArray<Target.Kind>>(["build", "test", "lint", "docs"])
    )
  ),
  /** @default ["main"] */
  pushBranches: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>(["main"]))
  ),
  /** @default true */
  pullRequest: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /** @default true */
  workflowDispatch: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /** @default true */
  cancelInProgress: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /**
   * The lockfile-respecting install the rendered pipeline runs before the
   * generated smithers build step, and the package manager whose workspace binary
   * that step invokes. Restricted to
   * {@link GithubWorkflow.supportedInstallCommands}: `render` refuses a job
   * that runs smithers build without a step performing this install.
   */
  install: Schema.optional(Schema.NonEmptyString),
  /**
   * The declared package manager. The generated pipeline installs with it and
   * runs the smthrs binary through it, so a workspace that switches managers
   * gets a regenerated workflow rather than a pipeline still calling pnpm.
   */
  packageManager: PackageManager.PackageManager,
  /**
   * The declared secret overriding the root RemoteCache endpoint.
   *
   * A {@link Secret} declaration rather than two strings. The old pair named a
   * GitHub secret and, separately, the environment variable it landed in, which
   * let a workflow set a variable nothing read. One declaration names the
   * variable, and the generated step reads the repository secret of the same
   * name, so the two cannot disagree.
   */
  cacheUrlSecret: Schema.optional(Secret.Declaration),
  /** The declared secret supplying the remote-cache bearer token. */
  cacheTokenSecret: Schema.optional(Secret.Declaration),
  /** The jobs `write` mode renders. Empty is legal for `contract` mode. @default [] */
  jobs: Schema.Array(Job).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Job>>([]))
  ),
  /** The commands the pipeline must run, in every mode. @default [] */
  gates: Schema.Array(Gate).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Gate>>([]))
  ),
  /**
   * Job ids the workflow must define, in every mode. `contract` requires them
   * of the checked-in file; `check` and `write` require them of the render.
   */
  requiredJobs: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Declared workflow output path. This stays a string because outputs are
   * declared paths, not input references. `contract` and `check` derive a
   * read declaration from the same output path for their non-writing view.
   */
  /** @default ".github/workflows/ci.yml" */
  output: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed(".github/workflows/ci.yml"))
  ),
  mode: OutputMode
})

/**
 * Attributes for {@link GithubCiGen}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

const ciKinds: ReadonlySet<Target.Kind> = new Set(["build", "test", "lint", "docs"])

/**
 * The kinds safe for an unattended generated pipeline. The CLI also exposes
 * `run`, but run targets include development servers and source-tree
 * scaffolds; generated CI must not start or mutate one merely because it is
 * addressable.
 *
 * @category constants
 * @since 0.1.0
 */
export const pipelineKinds: ReadonlyArray<Target.Kind> = ["build", "test", "lint", "docs"]

/**
 * One package-path or target-name component of a target pattern.
 *
 * A component starts with a letter, a digit, or `_`, which rejects the
 * option-like forms (`--help`, `-x`) whose only effect in a generated command
 * is a green no-op, and rejects `.` and `..` traversal along with them. It
 * carries no shell metacharacter, no `*`, no whitespace, and no quote.
 */
const patternComponent = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Whether every component of a package path is a supported one. */
const packagePath = (path: string): boolean => path.split("/").every((part) => patternComponent.test(part))

/**
 * Whether a string is a target pattern the CLI's label grammar accepts.
 *
 * The supported forms are exactly `//...`, `//pkg/...`, `//pkg`, `//pkg:target`,
 * and `//:target`. Everything else is refused, which is what makes the
 * generated command safe to render: `*` never reaches the shell to be expanded
 * against the checkout, `--help` never turns the pipeline's only real step into
 * a usage message that exits 0, and `//a/../b`, `//a//b`, and `//a:b:c` never
 * become a pattern the CLI would reject at run time instead of at plan time.
 */
const targetPattern = (pattern: string): boolean => {
  if (!pattern.startsWith("//")) return false
  const body = pattern.slice(2)
  if (body === "...") return true
  if (body.endsWith("/...")) {
    const prefix = body.slice(0, -4)
    return prefix !== "" && packagePath(prefix)
  }
  const colon = body.indexOf(":")
  if (colon === -1) return body !== "" && packagePath(body)
  if (body.indexOf(":", colon + 1) !== -1) return false
  const target = body.slice(colon + 1)
  const path = body.slice(0, colon)
  return patternComponent.test(target) && (path === "" || packagePath(path))
}

/**
 * Renders a validated pattern as ONE shell word.
 *
 * `targetPattern` already excludes the single quote, so the single-quoted form
 * is always well formed, and it is a literal word in every default GitHub
 * Actions shell — `bash` on Linux and macOS, `pwsh` on Windows. Nothing inside
 * is expanded, so a pattern is passed to the CLI exactly as declared.
 */
const shellArgument = (pattern: string): string => `'${pattern}'`

/**
 * Renders the compact CLI command set selected by the kinds attribute, bound
 * to the workspace binary the declared install put in the tree.
 */
const executionCommands = (attrs: Attrs, exec: string): ReadonlyArray<string> => {
  const kinds = [...new Set(attrs.kinds)]
  const pattern = shellArgument(attrs.pattern)
  return kinds.length === ciKinds.size && kinds.every((kind) => ciKinds.has(kind))
    ? [`${exec} smthrs ci ${pattern}`]
    : kinds.map((kind) => `${exec} smthrs ${kind} ${pattern}`)
}

/** GitHub's own job-id shape: a letter or `_`, then letters, digits, `-`, `_`. */
const jobIdShape = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** The shape of a `with:` input name and an environment variable name. */
const mappingKeyShape = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * Rejects declared jobs GitHub Actions would refuse, shadow, or run empty.
 *
 * Every target here is a shape the Actions contract already forbids, so the
 * refusal costs nothing that could have worked: duplicate job ids render
 * duplicate YAML mapping keys (GitHub keeps the last, and a gate could match
 * the one that never runs), a job needs at least one step, a step is exactly
 * one of `uses` or `run`, and a control character in a script is a command the
 * shell cannot run.
 */
const validateJobs = (attrs: Attrs): void => {
  const ids = new Set<string>()
  for (const job of attrs.jobs) {
    if (!jobIdShape.test(job.id)) {
      throw new Error(
        `GithubCiGen: ${JSON.stringify(job.id)} is not a valid job id; use letters, digits, "-", and "_"`
      )
    }
    if (ids.has(job.id)) {
      throw new Error(`GithubCiGen: duplicate job id ${JSON.stringify(job.id)}`)
    }
    ids.add(job.id)
    if (job.steps.length === 0) {
      throw new Error(`GithubCiGen: job ${JSON.stringify(job.id)} declares no steps`)
    }
    // The attrs schema already bounds this. It is checked again here because
    // `render` is exported and callable with an attrs value the schema never
    // constructed, and a job whose timeout the runner rejects or silently caps
    // is exactly the plan-time-visible red pipeline this target refuses to emit.
    if (
      job.timeoutMinutes !== undefined &&
      (!Number.isInteger(job.timeoutMinutes) ||
        job.timeoutMinutes < minimumTimeoutMinutes ||
        job.timeoutMinutes > maximumTimeoutMinutes)
    ) {
      throw new Error(
        `GithubCiGen: job ${
          JSON.stringify(job.id)
        } declares timeout-minutes ${job.timeoutMinutes}; GitHub Actions supports a whole number from ${minimumTimeoutMinutes} to ${maximumTimeoutMinutes}`
      )
    }
    for (const step of job.steps) {
      const label = step.name === undefined ? `a step of job ${JSON.stringify(job.id)}` : JSON.stringify(step.name)
      if (step.uses !== undefined && step.run !== undefined) {
        throw new Error(`GithubCiGen: ${label} declares both uses and run; a step is one or the other`)
      }
      if (step.uses === undefined && step.run === undefined) {
        throw new Error(`GithubCiGen: ${label} declares neither uses nor run, so it does nothing`)
      }
      if (step.uses === undefined && step.with !== undefined && Object.keys(step.with).length > 0) {
        throw new Error(`GithubCiGen: ${label} declares with: on a run step; with: only configures uses`)
      }
      // A multiline script is rendered as a block scalar, which never reaches
      // `scalar`, so its body is checked here.
      if (step.run !== undefined && controlCharacter.test(step.run)) {
        throw new Error(`GithubCiGen: ${label} has a control character in its run script`)
      }
      for (const key of [...Object.keys(step.with ?? {}), ...Object.keys(step.env ?? {})]) {
        if (!mappingKeyShape.test(key)) {
          throw new Error(`GithubCiGen: ${JSON.stringify(key)} in ${label} is not a valid with:/env: name`)
        }
      }
    }
  }
  const missingJobs = attrs.requiredJobs.filter((id) => !ids.has(id))
  if (missingJobs.length > 0) {
    throw new Error(
      `GithubCiGen: the rendered workflow is missing required jobs: ${missingJobs.join(", ")}`
    )
  }
}

/**
 * The lockfile-respecting install the generated pipeline runs.
 *
 * Derived from the declared manager unless the author wrote one. A derived
 * command is the frozen install for that manager, which is what a pipeline must
 * run: an install free to update the lockfile makes the pipeline's result depend
 * on when it ran.
 */
const installCommand = (attrs: Attrs): string =>
  attrs.install ?? PackageManager.install(attrs.packageManager, { frozen: true, ignoreScripts: false }).join(" ")

/**
 * Renders cache host state for the generated smthrs execution step.
 *
 * A declared secret becomes one environment entry whose value is the repository
 * secret of the same name. The value is a GitHub expression, so the credential
 * exists only inside the runner; nothing about it is written into the workflow
 * file or into this target's key.
 */
const cacheEnvironment = (attrs: Attrs): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {}
  if (attrs.cacheUrlSecret !== undefined) {
    env[attrs.cacheUrlSecret.env] = `\${{ secrets.${attrs.cacheUrlSecret.env} }}`
  }
  if (attrs.cacheTokenSecret !== undefined) {
    env[RemoteCache.normalizeTokenEnv(attrs.cacheTokenSecret.env)] = `\${{ secrets.${attrs.cacheTokenSecret.env} }}`
  }
  return env
}

/**
 * Renders the workflow YAML from attrs, deterministically.
 *
 * It FAILS CLOSED. A render throws at plan time, rather than emitting a
 * pipeline that silently checks less than the repository requires, when it
 * would drop a declared gate, drop a declared required job, install with
 * anything but a supported lockfile install, skip that install in the job that
 * runs smithers build, emit a smthrs verb the CLI does not have, or emit a job or
 * step shape GitHub Actions rejects. That refusal is the whole reason this target
 * can own a workflow file at all.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (attrs: Attrs): string => {
  const install = installCommand(attrs)
  const exec = GithubWorkflow.workspaceExec(install)
  if (exec === undefined) {
    throw new Error(
      `GithubCiGen: ${JSON.stringify(install)} is not a supported lockfile install; use one of ${
        GithubWorkflow.supportedInstallCommands.join(", ")
      }`
    )
  }
  if (attrs.jobs.length === 0) {
    throw new Error("GithubCiGen: write mode needs at least one declared job")
  }
  if (attrs.pushBranches.length === 0 && !attrs.pullRequest && !attrs.workflowDispatch) {
    throw new Error("GithubCiGen: write mode needs at least one workflow trigger")
  }
  if (!targetPattern(attrs.pattern)) {
    throw new Error(
      `GithubCiGen: ${
        JSON.stringify(attrs.pattern)
      } is not a target pattern; use //..., //pkg/..., //pkg, or //pkg:target`
    )
  }
  // No kinds means no generated smithers build step, which is a pipeline that runs
  // none of the workspace's targets while claiming to be its CI.
  if (attrs.kinds.length === 0) {
    throw new Error("GithubCiGen: write mode needs at least one kind for the generated smithers build step")
  }
  const unsafeKinds = [...new Set(attrs.kinds)].filter((kind) => !pipelineKinds.includes(kind))
  if (unsafeKinds.length > 0) {
    throw new Error(
      `GithubCiGen: generated workflows do not admit the kind ${
        unsafeKinds.map((kind) => JSON.stringify(kind)).join(", ")
      }; ${pipelineKinds.join(", ")} are the pipeline-safe verbs`
    )
  }
  validateJobs(attrs)
  // The generated smithers build step runs the workspace binary, so the job carrying
  // it has to have installed the workspace first. Requiring the declared step
  // rather than injecting one keeps the rendered pipeline the declared one.
  const host = attrs.jobs[0]!
  if (
    !host.steps.some((step) =>
      step.run !== undefined && GithubWorkflow.performsInstall(step.run, installCommand(attrs))
    )
  ) {
    throw new Error(
      `GithubCiGen: job ${JSON.stringify(host.id)} runs smithers build but no step runs the declared install ${
        JSON.stringify(installCommand(attrs))
      }; add it before the generated step`
    )
  }
  const triggers: Array<string> = []
  if (attrs.pushBranches.length > 0) {
    triggers.push("  push:", `    branches: [${attrs.pushBranches.map(scalar).join(", ")}]`)
  }
  if (attrs.pullRequest) triggers.push("  pull_request:")
  if (attrs.workflowDispatch) triggers.push("  workflow_dispatch:")
  const lines: Array<string> = [
    `name: ${scalar(attrs.workflowName)}`,
    "on:",
    ...triggers,
    "concurrency:",
    "  group: ci-${{ github.ref }}",
    `  cancel-in-progress: ${attrs.cancelInProgress}`,
    "jobs:"
  ]
  const cacheEnv = cacheEnvironment(attrs)
  for (const [index, job] of attrs.jobs.entries()) {
    // A job id is a mapping KEY, and YAML resolves a plain `no:` or `on:` to a
    // boolean just as it does a value, so an id that reads as one is quoted.
    lines.push(`  ${scalar(job.id)}:`)
    if (job.name !== undefined) lines.push(`    name: ${scalar(job.name)}`)
    lines.push(`    runs-on: ${runner(job.runsOn)}`)
    if (job.timeoutMinutes !== undefined) lines.push(`    timeout-minutes: ${job.timeoutMinutes}`)
    if (job.continueOnError !== undefined) lines.push(`    continue-on-error: ${job.continueOnError}`)
    lines.push("    steps:")
    for (const step of job.steps) lines.push(...renderStep(step, "      "))
    if (index === 0) {
      for (const command of executionCommands(attrs, exec)) {
        lines.push(...renderStep({
          run: command,
          ...(Object.keys(cacheEnv).length === 0 ? {} : { env: cacheEnv })
        }, "      "))
      }
    }
  }
  const rendered = `${lines.join("\n")}\n`
  const missing = GithubWorkflow.missingGates(GithubWorkflow.parseWorkflow(rendered), attrs.gates)
  if (missing.length > 0) {
    throw new Error(
      `GithubCiGen: the rendered workflow does not run ${
        missing.map((gate) => `${gate.name} (${gate.command})`).join(", ")
      }; declare the step or drop the gate`
    )
  }
  return rendered
}

/**
 * Generates or verifies the GitHub Actions CI workflow from BUILD.ts attrs.
 *
 * **Why the default is `contract` and not `write`.** The previous shape of
 * this target rendered a fixed five-step job whose entire pipeline was
 * `pnpm dlx @smthrs/build-cli ci //...`, and pointed `output` at
 * `.github/workflows/ci.yml`. Building the root target therefore replaced a
 * seven-job pipeline — typecheck, lint, circular-dependency guard, browser
 * bundle gate, release pack smoke test, Rust fmt/clippy/test, WASM
 * reproducibility, Bun, macOS, Windows — with one job that ran none of them,
 * and nothing in the target could notice. A generator that can silently delete
 * a repository's required gates is not safe to run by default, so:
 *
 * - `contract` (default) never writes. It reads the checked-in workflow,
 *   parses it, and fails with {@link DriftError} unless every
 *   declared {@link Gate} is still run by an unconditional step of an
 *   unconditional job and every declared job id still exists and still runs
 *   unconditionally ({@link missingRequiredJobs}). A repository
 *   keeps its hand-written pipeline — comments, advisory `continue-on-error`
 *   lanes, platform jobs — and gains a machine-checked guarantee that its gates
 *   cannot be quietly removed. `continue-on-error` stays advisory on purpose: a
 *   gate asserts that a command still runs, not that its failure blocks a
 *   merge, and the advisory platform lanes are exactly what a platform-pinned
 *   gate pins. An `if:` is treated the other way, because GitHub may skip the
 *   job or step entirely.
 * - `check` byte-compares the checked-in file against the rendered form, for
 *   a repository that does want its pipeline generated.
 * - `write` renders and writes. {@link render} refuses to emit a workflow that
 *   drops a declared gate or a declared required job, installs with anything
 *   other than a supported lockfile command, runs smithers build in a job that never
 *   performs that install, names a kind the CLI has no verb for, or declares a
 *   job or step shape GitHub Actions rejects — so even the writing path cannot
 *   downgrade the pipeline.
 *
 * The `lint` verb maps `write` to `check` through `attrsForKind`, so no lint
 * or `ci` run mutates a workflow file. Only `contract` and `check` are
 * cacheable; the output file is a declared input in both, so editing the
 * workflow re-keys the target. The first rendered job receives one
 * `<exec> smthrs ci <pattern>` step when `kinds` is exactly build, test,
 * lint, and docs. Every other set receives one
 * `<exec> smithers build <verb> <pattern>` step
 * per kind, for the kinds in {@link pipelineKinds}. `<exec>` is the
 * workspace-binary runner of the declared install
 * ({@link GithubWorkflow.workspaceExecCommands}), so the CLI that runs is the
 * one the lockfile pinned, never a fetched one.
 *
 * Generated command example:
 *
 * ```yaml
 * - run: pnpm exec smthrs ci '//...'
 * ```
 *
 * The pattern is validated against the CLI's label grammar and rendered as one
 * single-quoted shell word, so it cannot be glob-expanded by the runner's
 * shell or read as an option.
 *
 * @category targets
 * @since 0.1.0
 */
export const GithubCiGen = Target.make("GithubCiGen", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  error: Schema.Union([WriteFileError, DriftError]),
  cache: (attrs) => attrs.mode !== "write",
  inputs: (attrs) => attrs.mode === "write" ? [] : [Input.file(`//${resolveOutputPath(attrs.output)}`)],
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (
    attrs
  ): Node.Node<
    void,
    WriteFileError | DriftError,
    | Action.Requirement<"smithers-build/write-file">
    | Action.Requirement<"smithers-build/check-file">
    | Action.Requirement<"smithers-build/check-workflow">
  > =>
    attrs.mode === "contract"
      ? CheckWorkflow.call({
        path: resolveOutputPath(attrs.output),
        gates: attrs.gates,
        requiredJobs: attrs.requiredJobs
      })
      : generateFile(attrs.mode, { path: resolveOutputPath(attrs.output), contents: render(attrs) })
})
